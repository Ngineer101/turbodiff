import { env } from 'cloudflare:workers';
import {
  deletePushSubscriptionById,
  getPlan,
  listPushSubscriptionsForUser,
  type PushSubscriptionRow,
} from './db.ts';

// Server-side Web Push sending, isolated from planner.ts so a notification
// failure can never affect plan state — every entry point here fails open
// (catches its own errors) rather than throwing.
//
// The wire protocol is implemented in-repo with plain WebCrypto (matching
// github-app.ts / email.ts style): RFC 8291 aes128gcm payload encryption and
// RFC 8292 vapid authorization. Apple's push service rejects the obsolete
// pre-RFC protocol (aesgcm + `WebPush <jwt>`) outright, so only the modern
// scheme works across all push services.

export type PushSendResult = 'sent' | 'gone' | 'error';

const encoder = new TextEncoder();

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function hkdfSha256(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  byteLength: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt, info },
      key,
      byteLength * 8,
    ),
  );
}

// RFC 8291 aes128gcm encryption of one payload for one subscriber, as a single
// record: ephemeral ECDH over the subscription's p256dh key, HKDF key schedule
// bound to the auth secret and both public keys, then AES-128-GCM. Returns the
// full request body: coding header (salt || rs || keyid) followed by the record.
async function encryptPayload(
  plaintext: Uint8Array,
  p256dh: string,
  auth: string,
): Promise<Uint8Array> {
  const uaPublicRaw = b64urlDecode(p256dh); // subscriber's uncompressed P-256 point (65 bytes)
  const authSecret = b64urlDecode(auth); // subscriber's 16-byte auth secret
  const uaPublicKey = await crypto.subtle.importKey(
    'raw',
    uaPublicRaw,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  if (!('privateKey' in ephemeral)) throw new Error('expected an ECDH key pair');
  const asPublicExport = await crypto.subtle.exportKey('raw', ephemeral.publicKey);
  if (!(asPublicExport instanceof ArrayBuffer)) throw new Error('expected raw key export');
  const asPublicRaw = new Uint8Array(asPublicExport); // our uncompressed P-256 point (65 bytes)

  // workerd's generated types name the ECDH peer key `$public` (JSG's
  // reserved-word escape leaks into the .d.ts) but the runtime property is the
  // spec's `public`; passing a variable sidesteps the excess-property check.
  const ecdhParams = { name: 'ECDH', public: uaPublicKey };
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(ecdhParams, ephemeral.privateKey, 256),
  );
  const ikm = await hkdfSha256(
    authSecret,
    ecdhSecret,
    concatBytes(encoder.encode('WebPush: info\0'), uaPublicRaw, asPublicRaw),
    32,
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdfSha256(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdfSha256(salt, ikm, encoder.encode('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // 0x02 marks the final (here: only) record; no extra zero padding needed.
  const record = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce },
      aesKey,
      concatBytes(plaintext, Uint8Array.of(0x02)),
    ),
  );

  // Coding header: salt(16) || record size uint32-BE || keyid length(1) || keyid.
  const header = new Uint8Array(16 + 4 + 1 + asPublicRaw.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublicRaw.length;
  header.set(asPublicRaw, 21);
  return concatBytes(header, record);
}

// VAPID keys never rotate within an isolate's lifetime; cache the imported key.
let cachedVapidKey: CryptoKey | null = null;

async function vapidSigningKey(publicRaw: Uint8Array): Promise<CryptoKey> {
  if (cachedVapidKey) return cachedVapidKey;
  cachedVapidKey = await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      d: env.VAPID_PRIVATE_KEY,
      x: b64url(publicRaw.slice(1, 33)),
      y: b64url(publicRaw.slice(33, 65)),
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  return cachedVapidKey;
}

// RFC 8292 `vapid t=<jwt>, k=<public key>` authorization header for one
// push-service origin.
async function vapidAuthorization(endpoint: string): Promise<string> {
  const publicRaw = b64urlDecode(env.VAPID_PUBLIC_KEY);
  if (publicRaw.length !== 65 || publicRaw[0] !== 0x04) {
    throw new Error('VAPID_PUBLIC_KEY must be a base64url uncompressed P-256 point (65 bytes)');
  }
  const header = b64url(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(
    encoder.encode(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
        sub: env.VAPID_SUBJECT,
      }),
    ),
  );
  // WebCrypto ECDSA emits the raw 64-byte r||s signature JWS expects — no DER
  // conversion needed.
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    await vapidSigningKey(publicRaw),
    encoder.encode(`${header}.${claims}`),
  );
  return `vapid t=${header}.${claims}.${b64url(sig)}, k=${env.VAPID_PUBLIC_KEY}`;
}

export async function sendPushToSubscription(
  sub: PushSubscriptionRow,
  payload: { title: string; body: string; url: string },
): Promise<PushSendResult> {
  try {
    const body = await encryptPayload(
      encoder.encode(JSON.stringify(payload)),
      sub.p256dh,
      sub.auth,
    );
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        authorization: await vapidAuthorization(sub.endpoint),
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        ttl: '86400',
        urgency: 'high',
      },
      body,
    });
    if (res.status === 404 || res.status === 410) return 'gone';
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200);
      console.error(
        'turbodiff: push service rejected send',
        new URL(sub.endpoint).origin,
        res.status,
        detail,
      );
      return 'error';
    }
    return 'sent';
  } catch (err) {
    console.error('turbodiff: push send failed for subscription', sub.id, err);
    return 'error';
  }
}

// Pushes to every stored subscription of the plan's creator. No-ops for
// operator/API-created plans (no created_by_id to resolve). Never throws —
// a planner call site never needs its own error handling around this.
export async function notifyPlanUsers(
  planId: number,
  payload: { title: string; body: string; url: string },
): Promise<void> {
  try {
    const plan = await getPlan(planId);
    if (!plan || plan.created_by_id === null) return;
    const subs = await listPushSubscriptionsForUser(plan.created_by_id);
    const results = await Promise.all(
      subs.map(async (sub) => ({ sub, result: await sendPushToSubscription(sub, payload) })),
    );
    await Promise.all(
      results
        .filter(({ result }) => result === 'gone')
        .map(({ sub }) => deletePushSubscriptionById(sub.id)),
    );
  } catch (err) {
    console.error('turbodiff: notifyPlanUsers failed for plan', planId, err);
  }
}
