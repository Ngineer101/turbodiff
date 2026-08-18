import { env } from 'cloudflare:workers';

// AES-256-GCM sealing for per-connection bearer tokens. The key is the
// TOKEN_ENCRYPTION_KEY secret (64 hex chars — generate with
// `openssl rand -hex 32`); sealed values are base64url(iv || ciphertext).
// Tokens are decrypted only inside the MCP auth resolver at request time and
// are never rendered back to the UI or into model context.

function keyBytes(): Uint8Array {
  const hex = env.TOKEN_ENCRYPTION_KEY;
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      'TOKEN_ENCRYPTION_KEY must be a 64-hex-char secret (openssl rand -hex 32); ' +
        'set it with `wrangler secret put TOKEN_ENCRYPTION_KEY` (or in .dev.vars locally)',
    );
  }
  return Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));
}

export function encryptionConfigured(): boolean {
  try {
    keyBytes();
    return true;
  } catch {
    return false;
  }
}

async function aesKey(usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', keyBytes(), 'AES-GCM', false, [usage]);
}

function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export async function sealToken(plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      await aesKey('encrypt'),
      new TextEncoder().encode(plain),
    ),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64url(out);
}

export async function openToken(sealed: string): Promise<string> {
  const bytes = b64urlDecode(sealed);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.slice(0, 12) },
    await aesKey('decrypt'),
    bytes.slice(12),
  );
  return new TextDecoder().decode(plain);
}

// JSON-blob variants of sealToken/openToken, for connection auth configs
// (api_key, client_credentials, oauth) that carry more than one secret field.
export async function sealJson<T>(value: T): Promise<string> {
  return sealToken(JSON.stringify(value));
}

export async function openJson<T>(sealed: string): Promise<T> {
  // SAFETY: sealed blobs are only ever produced by sealJson<T> over the same
  // caller-chosen T, so the decrypted JSON round-trips back to that shape.
  return JSON.parse(await openToken(sealed)) as T;
}

// --- artifact URL signing (capability URLs for verification screenshots) ---
//
// R2 artifact keys are served publicly so GitHub can render them inline in PR
// comments, but the URL must be unguessable: each carries an HMAC of its key
// (signed with SESSION_SECRET), so knowing one URL grants exactly that object
// and enumeration is impossible. No expiry — PR evidence shouldn't rot.

async function artifactMac(key: string): Promise<string> {
  const mac = await crypto.subtle.sign(
    'HMAC',
    await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(env.SESSION_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    ),
    new TextEncoder().encode(`artifact:${key}`),
  );
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function signArtifactKey(key: string): Promise<string> {
  return artifactMac(key);
}

export async function verifyArtifactSig(key: string, sig: string): Promise<boolean> {
  return timingSafeEqual(await artifactMac(key), sig);
}

// Constant-time string comparison: hash both sides first so neither content
// nor length differences shape the timing.
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}
