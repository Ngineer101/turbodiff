import { env } from 'cloudflare:workers';

// Stateless sessions: an HMAC-signed JSON payload in an HttpOnly cookie.
// Holds the GitHub user identity plus their OAuth token (needed on each
// settings request to re-check which installations they may manage).

export interface Session {
  userId: number;
  login: string;
  ghToken: string;
  exp: number; // unix seconds
}

export const SESSION_COOKIE = 'turbodiff_session';
export const SESSION_TTL_SECONDS = 8 * 60 * 60; // matches GitHub user-token expiry

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

async function hmacKey(usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(env.SESSION_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  );
}

export async function sealSession(session: Session): Promise<string> {
  const payload = b64url(encoder.encode(JSON.stringify(session)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey('sign'), encoder.encode(payload));
  return `${payload}.${b64url(sig)}`;
}

export async function openSession(cookieValue: string | undefined): Promise<Session | null> {
  if (!cookieValue) return null;
  const [payload, sig] = cookieValue.split('.');
  if (!payload || !sig) return null;
  const valid = await crypto.subtle
    .verify('HMAC', await hmacKey('verify'), b64urlDecode(sig), encoder.encode(payload))
    .catch(() => false);
  if (!valid) return null;
  try {
    const session = JSON.parse(new TextDecoder().decode(b64urlDecode(payload))) as Session;
    if (session.exp * 1000 < Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}

export function randomToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return b64url(bytes);
}
