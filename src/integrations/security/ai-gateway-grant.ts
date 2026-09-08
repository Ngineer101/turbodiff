import { isJsonObject, isNumber, isString, parseJson } from '../../shared/json.ts';

interface AiGatewayGrant {
  v: 1;
  model: string;
  exp: number;
}

// Long enough for a complete sandbox step (including a repair turn), but far
// shorter-lived and dramatically narrower than the account API token it
// replaces. The grant can call exactly one model through the model proxy.
export const AI_GATEWAY_GRANT_TTL_MS = 2 * 60 * 60_000;

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid base64url');
  const padded = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function hmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  );
}

// The explicit-secret forms keep the capability format independently
// testable. Production callers use mintAiGatewayGrant/verifyAiGatewayGrant,
// which never expose the Cloudflare API token outside this Worker.
export async function createAiGatewayGrant(
  secret: string,
  model: string,
  expiresAt: number,
): Promise<string> {
  const encodedPayload = base64Url(
    new TextEncoder().encode(
      JSON.stringify({ v: 1, model, exp: expiresAt } satisfies AiGatewayGrant),
    ),
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    await hmacKey(secret, 'sign'),
    new TextEncoder().encode(encodedPayload),
  );
  return `${encodedPayload}.${base64Url(new Uint8Array(signature))}`;
}

export async function verifyAiGatewayGrantWithSecret(
  secret: string,
  token: string,
  now = Date.now(),
): Promise<AiGatewayGrant | null> {
  try {
    const [encodedPayload, encodedSignature, ...extra] = token.split('.');
    if (!encodedPayload || !encodedSignature || extra.length > 0) return null;
    const valid = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret, 'verify'),
      base64UrlDecode(encodedSignature),
      new TextEncoder().encode(encodedPayload),
    );
    if (!valid) return null;
    const payload = parseJson(new TextDecoder().decode(base64UrlDecode(encodedPayload)));
    if (
      !isJsonObject(payload) ||
      payload.v !== 1 ||
      !isString(payload.model) ||
      !payload.model ||
      !isNumber(payload.exp) ||
      payload.exp <= now
    ) {
      return null;
    }
    return { v: 1, model: payload.model, exp: payload.exp };
  } catch {
    return null;
  }
}
