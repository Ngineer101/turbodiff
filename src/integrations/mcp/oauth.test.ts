import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { isString, parseJson, type JsonObject, type JsonValue } from '../../shared/json.ts';
// Co-located with the OAuth protocol adapter.
import {
  discoverOAuthEndpoints,
  generatePkce,
  packState,
  registerOAuthClient,
  unpackState,
} from './oauth.ts';

const SECRET = 'test-session-secret';

function b64urlToBytes(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// Serves the given URL→body map; every other URL 404s. Discovery treats a
// non-2xx as "document not published here" and moves on, so unmapped URLs
// behave like a real server without that well-known path.
function stubFetch(routes: Record<string, JsonObject>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      return url in routes
        ? new Response(JSON.stringify(routes[url]), {
            headers: { 'content-type': 'application/json' },
          })
        : new Response('not found', { status: 404 });
    }),
  );
}

describe('discoverOAuthEndpoints', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const metadata = {
    authorization_endpoint: 'https://auth.example.com/oauth2/authorize',
    token_endpoint: 'https://auth.example.com/oauth2/token',
    registration_endpoint: 'https://auth.example.com/oauth2/register',
    scopes_supported: ['mcp'],
    token_endpoint_auth_methods_supported: ['none'],
  };

  it('discovers a path-less authorization server (appended and inserted forms coincide)', async () => {
    stubFetch({
      'https://mcp.example.com/.well-known/oauth-protected-resource': {
        authorization_servers: ['https://auth.example.com'],
      },
      'https://auth.example.com/.well-known/oauth-authorization-server': metadata,
    });
    const endpoints = await discoverOAuthEndpoints('https://mcp.example.com');
    expect(endpoints).toMatchObject({
      authorizationEndpoint: metadata.authorization_endpoint,
      tokenEndpoint: metadata.token_endpoint,
      registrationEndpoint: metadata.registration_endpoint,
      scopesSupported: ['mcp'],
      tokenEndpointAuthMethodsSupported: ['none'],
    });
  });

  it('discovers a path-bearing authorization server via the RFC 8414 inserted form', async () => {
    // The Stripe shape: the resource names https://access.example.com/mcp,
    // whose metadata lives at /.well-known/oauth-authorization-server/mcp —
    // the appended form 404s.
    stubFetch({
      'https://mcp.example.com/.well-known/oauth-protected-resource': {
        authorization_servers: ['https://access.example.com/mcp'],
      },
      'https://access.example.com/.well-known/oauth-authorization-server/mcp': metadata,
    });
    const endpoints = await discoverOAuthEndpoints('https://mcp.example.com');
    expect(endpoints.authorizationEndpoint).toBe(metadata.authorization_endpoint);
    expect(endpoints.tokenEndpoint).toBe(metadata.token_endpoint);
  });

  it('falls back to appended OpenID Connect discovery for a path-bearing issuer', async () => {
    stubFetch({
      'https://mcp.example.com/.well-known/oauth-protected-resource': {
        authorization_servers: ['https://auth.example.com/tenant1'],
      },
      'https://auth.example.com/tenant1/.well-known/openid-configuration': metadata,
    });
    const endpoints = await discoverOAuthEndpoints('https://mcp.example.com');
    expect(endpoints.tokenEndpoint).toBe(metadata.token_endpoint);
  });

  it('finds protected-resource metadata at the path-inserted form for a path-mounted MCP server', async () => {
    stubFetch({
      'https://mcp.example.com/.well-known/oauth-protected-resource/mcp': {
        authorization_servers: ['https://auth.example.com'],
      },
      'https://auth.example.com/.well-known/oauth-authorization-server': metadata,
    });
    const endpoints = await discoverOAuthEndpoints('https://mcp.example.com/mcp');
    expect(endpoints.tokenEndpoint).toBe(metadata.token_endpoint);
  });

  it('throws when no metadata document is published at any candidate URL', async () => {
    stubFetch({
      'https://mcp.example.com/.well-known/oauth-protected-resource': {
        authorization_servers: ['https://auth.example.com/mcp'],
      },
    });
    await expect(discoverOAuthEndpoints('https://mcp.example.com')).rejects.toThrow(
      /could not discover OAuth endpoints/,
    );
  });

  it('rejects a discovered authorization server that is not https', async () => {
    stubFetch({
      'https://mcp.example.com/.well-known/oauth-protected-resource': {
        authorization_servers: ['http://evil.example.com'],
      },
    });
    await expect(discoverOAuthEndpoints('https://mcp.example.com')).rejects.toThrow(
      /must be an https:\/\/ URL/,
    );
  });
});

describe('registerOAuthClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const ENDPOINT = 'https://auth.example.com/oauth2/register';
  const REDIRECT = 'https://app.example.com/api/integrations/1/oauth/callback';

  // Returns the JSON bodies of the registration requests the code sent.
  function stubRegistration(response: JsonObject, status = 201): JsonValue[] {
    const bodies: JsonValue[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL, init?: RequestInit) => {
        bodies.push(isString(init?.body) ? parseJson(init.body) : null);
        return new Response(JSON.stringify(response), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    return bodies;
  }

  it('registers as a public client when the server only supports none (the Stripe shape)', async () => {
    const bodies = stubRegistration({ client_id: 'oacli_1', token_endpoint_auth_method: 'none' });
    const registered = await registerOAuthClient(ENDPOINT, REDIRECT, {
      clientName: 'turbodiff',
      clientUri: 'https://app.example.com',
      authMethodsSupported: ['none'],
    });
    expect(registered).toEqual({ clientId: 'oacli_1', clientSecret: undefined });
    expect(bodies[0]).toMatchObject({
      client_name: 'turbodiff',
      client_uri: 'https://app.example.com',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
  });

  it('prefers client_secret_post when the server advertises it', async () => {
    const bodies = stubRegistration({ client_id: 'c1', client_secret: 's1' });
    const registered = await registerOAuthClient(ENDPOINT, REDIRECT, {
      clientName: 'turbodiff',
      authMethodsSupported: ['client_secret_basic', 'client_secret_post', 'none'],
    });
    expect(registered).toEqual({ clientId: 'c1', clientSecret: 's1' });
    expect(bodies[0]).toMatchObject({ token_endpoint_auth_method: 'client_secret_post' });
  });

  it('keeps the client_secret_post default when the server advertises no method list', async () => {
    const bodies = stubRegistration({ client_id: 'c1', client_secret: 's1' });
    await registerOAuthClient(ENDPOINT, REDIRECT, { clientName: 'turbodiff' });
    expect(bodies[0]).toMatchObject({ token_endpoint_auth_method: 'client_secret_post' });
  });

  it('surfaces a rejected registration with the server detail', async () => {
    stubRegistration(
      { error: 'invalid_client_metadata', error_description: 'Missing required param: x.' },
      400,
    );
    await expect(
      registerOAuthClient(ENDPOINT, REDIRECT, { clientName: 'turbodiff' }),
    ).rejects.toThrow(/HTTP 400.*Missing required param/s);
  });

  it('throws when the response carries no client_id', async () => {
    stubRegistration({ token_endpoint_auth_method: 'none' });
    await expect(
      registerOAuthClient(ENDPOINT, REDIRECT, { clientName: 'turbodiff' }),
    ).rejects.toThrow(/did not return a client_id/);
  });
});

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
