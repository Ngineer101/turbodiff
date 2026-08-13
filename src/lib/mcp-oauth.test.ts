import { describe, expect, it } from 'vite-plus/test';
import { generatePkce, packState, unpackState } from './mcp-oauth.ts';

const SECRET = 'test-session-secret';

function b64urlToBytes(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

describe('generatePkce', () => {
  it('derives the challenge as base64url(SHA-256(verifier))', async () => {
    const { verifier, challenge } = await generatePkce();
    const expected = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
    );
    expect(b64urlToBytes(challenge)).toEqual(expected);
  });

  it('produces a fresh verifier on every call', async () => {
    const a = await generatePkce();
    const b = await generatePkce();
    expect(a.verifier).not.toBe(b.verifier);
  });
});

describe('packState / unpackState', () => {
  it('round-trips the connection id and verifier', async () => {
    const state = await packState({ connectionId: 42, verifier: 'abc123' }, SECRET);
    expect(await unpackState(state, SECRET)).toEqual({ connectionId: 42, verifier: 'abc123' });
  });

  it('rejects a state signed with a different secret', async () => {
    const state = await packState({ connectionId: 1, verifier: 'v' }, SECRET);
    expect(await unpackState(state, 'wrong-secret')).toBeNull();
  });

  it('rejects a tampered payload even if the signature parses', async () => {
    const state = await packState({ connectionId: 1, verifier: 'v' }, SECRET);
    const [body, sig] = state.split('.');
    const tamperedBody = btoa('{"connectionId":999,"verifier":"v","exp":9999999999999}')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(await unpackState(`${tamperedBody}.${sig}`, SECRET)).toBeNull();
    expect(await unpackState(`${body}.${sig}`, SECRET)).not.toBeNull(); // sanity: original still valid
  });

  it('rejects malformed state strings', async () => {
    expect(await unpackState('not-a-valid-state', SECRET)).toBeNull();
    expect(await unpackState('', SECRET)).toBeNull();
  });

  it('rejects an expired state', async () => {
    // Hand-build a state whose embedded exp is already in the past, since
    // packState itself always stamps now + 10min.
    const past = { connectionId: 7, verifier: 'v', exp: Date.now() - 1000 };
    const body = btoa(JSON.stringify(past))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const sig = await (async () => {
      const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(SECRET),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const mac = new Uint8Array(
        await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)),
      );
      let bin = '';
      for (const b of mac) bin += String.fromCharCode(b);
      return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    })();
    expect(await unpackState(`${body}.${sig}`, SECRET)).toBeNull();
  });
});
