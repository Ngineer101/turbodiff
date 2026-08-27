// Hand-rolled OAuth mechanics for MCP server auth: RFC 9728 protected-resource
// discovery, RFC 8414 authorization-server metadata (falling back to OpenID
// Connect discovery), RFC 7591 dynamic client registration, RFC 7636 PKCE,
// and the authorization_code / refresh_token / client_credentials token
// grants. Mirrors the fetch style of mcp-test.ts and github-app.ts's OAuth
// exchange/refresh — no MCP SDK or OAuth client library dependency.
//
// Deliberately free of any `cloudflare:workers` import (unlike crypto.ts) so
// this whole module loads under plain Vitest: packState/unpackState take
// their HMAC secret as an explicit parameter instead of reading
// env.SESSION_SECRET themselves, keeping every export here a pure function
// testable without a Workers runtime. Callers (src/http/api.ts) pass
// env.SESSION_SECRET in.

import {
  isJsonArray,
  isJsonObject,
  isNumber,
  isString,
  parseJson,
  type JsonObject,
  type JsonValue,
} from '../../shared/json.ts';

function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// --- endpoint discovery ---

export interface OAuthEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  // Advertised scopes (RFC 8414 scopes_supported). Requested verbatim during
  // authorization — some servers only issue refresh tokens when the request
  // names a scope (e.g. offline_access).
  scopesSupported?: string[];
}

async function fetchJson(url: string): Promise<JsonObject | null> {
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const parsed = parseJson(await res.text());
    return isJsonObject(parsed) ? parsed : null;
  } catch (err) {
    console.warn(`turbodiff: oauth metadata fetch failed for ${url}:`, err);
    return null;
  }
}

// Discovered URLs come from the MCP server's own metadata — attacker-
// influenced if that server is malicious or later compromised. They become a
// browser redirect target (authorization endpoint) and the POST target for
// the auth code + client secret (token endpoint), so require https; plain
// http only for local development targets, mirroring validConnectionUrl in
// the API layer.
function assertSecureUrl(raw: string, label: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`discovered ${label} is not a valid URL`);
  }
  const localDev = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !localDev) {
    throw new Error(`discovered ${label} must be an https:// URL, got: ${url.protocol}`);
  }
}

// RFC 8414 §3 and RFC 9728 §3 build well-known URLs by *inserting* the
// well-known segment between host and path — an issuer/resource of
// https://host/path publishes at https://host/.well-known/<doc>/path (this
// is how Stripe's https://access.stripe.com/mcp serves its metadata).
// OpenID Connect Discovery predates that rule and *appends* instead
// (https://host/path/.well-known/openid-configuration); live servers exist
// on both conventions. For a URL with no path the two forms coincide.
function wellKnown(base: URL, doc: string, form: 'insert' | 'append'): string {
  const path = base.pathname.replace(/\/+$/, '');
  return form === 'insert'
    ? `${base.origin}/.well-known/${doc}${path}`
    : `${base.origin}${path}/.well-known/${doc}`;
}

async function fetchFirstJson(urls: string[]): Promise<JsonObject | null> {
  for (const url of new Set(urls)) {
    const data = await fetchJson(url);
    if (data) return data;
  }
  return null;
}

export async function discoverOAuthEndpoints(mcpServerUrl: string): Promise<OAuthEndpoints> {
  const server = new URL(mcpServerUrl);

  // RFC 9728: the MCP server names which authorization server(s) protect it.
  // A server mounted on a path publishes at the path-inserted form; the
  // origin root stays as a fallback for servers that predate that rule.
  // Fall back to the MCP server's own origin as the authorization server —
  // the MCP spec's baseline for servers that are their own authorization
  // server.
  const resource = await fetchFirstJson([
    wellKnown(server, 'oauth-protected-resource', 'insert'),
    `${server.origin}/.well-known/oauth-protected-resource`,
  ]);
  const servers = resource?.authorization_servers;
  const authServer = isJsonArray(servers) && isString(servers[0]) ? servers[0] : server.origin;
  assertSecureUrl(authServer, 'authorization server');

  // RFC 8414, falling back to OpenID Connect discovery for authorization
  // servers that only publish that document. Spec-correct inserted form
  // first, appended form second for each document.
  const issuer = new URL(authServer);
  const metadata = await fetchFirstJson([
    wellKnown(issuer, 'oauth-authorization-server', 'insert'),
    wellKnown(issuer, 'oauth-authorization-server', 'append'),
    wellKnown(issuer, 'openid-configuration', 'insert'),
    wellKnown(issuer, 'openid-configuration', 'append'),
  ]);
  const authorizationEndpoint = metadata?.authorization_endpoint;
  const tokenEndpoint = metadata?.token_endpoint;
  if (!isString(authorizationEndpoint) || !isString(tokenEndpoint)) {
    throw new Error(
      `could not discover OAuth endpoints for ${authServer} (no oauth-authorization-server or openid-configuration metadata)`,
    );
  }
  assertSecureUrl(authorizationEndpoint, 'authorization endpoint');
  assertSecureUrl(tokenEndpoint, 'token endpoint');
  const rawRegistrationEndpoint = metadata?.registration_endpoint;
  const registrationEndpoint = isString(rawRegistrationEndpoint)
    ? rawRegistrationEndpoint
    : undefined;
  if (registrationEndpoint) assertSecureUrl(registrationEndpoint, 'registration endpoint');
  const rawScopes = metadata?.scopes_supported;
  const scopesSupported = isJsonArray(rawScopes) ? rawScopes.filter(isString) : undefined;
  return { authorizationEndpoint, tokenEndpoint, registrationEndpoint, scopesSupported };
}

// --- dynamic client registration (RFC 7591) ---

export interface RegisteredClient {
  clientId: string;
  clientSecret?: string;
}

export async function registerOAuthClient(
  registrationEndpoint: string,
  redirectUri: string,
): Promise<RegisteredClient> {
  const res = await fetch(registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
    }),
  });
  if (!res.ok) {
    throw new Error(
      `dynamic client registration failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`,
    );
  }
  const data = parseJson(await res.text());
  if (!isJsonObject(data) || !isString(data.client_id) || !data.client_id) {
    throw new Error('dynamic client registration did not return a client_id');
  }
  return {
    clientId: data.client_id,
    clientSecret: isString(data.client_secret) ? data.client_secret : undefined,
  };
}

// --- PKCE (RFC 7636) ---

export interface Pkce {
  verifier: string;
  challenge: string;
}

export async function generatePkce(): Promise<Pkce> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

// --- signed state (no server-side "pending flow" table) ---

export interface OAuthStatePayload {
  connectionId: number;
  verifier: string;
}

const STATE_TTL_MS = 10 * 60_000;

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

// Opaque state: base64url(json) + '.' + base64url(hmac). The expiry (now +
// 10min) travels inside the signed payload, so a tampered or stale state is
// simply rejected by unpackState — nothing to clean up server-side.
export async function packState(payload: OAuthStatePayload, secret: string): Promise<string> {
  const body = b64url(
    new TextEncoder().encode(JSON.stringify({ ...payload, exp: Date.now() + STATE_TTL_MS })),
  );
  const sig = b64url(
    new Uint8Array(
      await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(body)),
    ),
  );
  return `${body}.${sig}`;
}

export async function unpackState(
  state: string,
  secret: string,
): Promise<OAuthStatePayload | null> {
  const [body, sig] = state.split('.');
  if (!body || !sig) return null;
  let valid: boolean;
  try {
    valid = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret),
      b64urlDecode(sig),
      new TextEncoder().encode(body),
    );
  } catch {
    return null;
  }
  if (!valid) return null;
  let parsed: JsonValue;
  try {
    parsed = parseJson(new TextDecoder().decode(b64urlDecode(body)));
  } catch {
    return null;
  }
  if (!isJsonObject(parsed)) return null;
  const { connectionId, verifier, exp } = parsed;
  if (!isNumber(connectionId) || !isString(verifier) || !isNumber(exp)) return null;
  if (Date.now() > exp) return null;
  return { connectionId, verifier };
}

// --- token grants ---

export interface TokenResult {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string; // ISO-8601 absolute expiry
  scope?: string;
}

function expiresAtFrom(expiresIn: JsonValue | undefined): string | undefined {
  const seconds = isNumber(expiresIn) ? expiresIn : Number(expiresIn);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return new Date(Date.now() + seconds * 1000).toISOString();
}

// Standard OAuth 2 token endpoints take application/x-www-form-urlencoded
// (RFC 6749), unlike the JSON APIs mcp-test.ts/github-app.ts otherwise talk
// to. Returns null only on a network-level failure — a non-2xx response with
// a JSON error body still parses, so callers can surface error_description.
async function tokenRequest(
  tokenEndpoint: string,
  params: URLSearchParams,
): Promise<JsonObject | null> {
  let res: Response;
  try {
    res = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { accept: 'application/json' },
      body: params,
    });
  } catch (err) {
    console.warn(`turbodiff: oauth token request failed for ${tokenEndpoint}:`, err);
    return null;
  }
  try {
    const parsed = parseJson(await res.text());
    return isJsonObject(parsed) ? parsed : null;
  } catch (err) {
    console.warn(
      `turbodiff: oauth token response was not JSON from ${tokenEndpoint} (HTTP ${res.status}):`,
      err,
    );
    return null;
  }
}

function describeTokenError(data: JsonObject | null): string {
  const errorDescription = data?.error_description;
  if (isString(errorDescription)) return errorDescription;
  const error = data?.error;
  if (isString(error)) return error;
  return 'no access_token returned';
}

export async function exchangeAuthorizationCode(
  tokenEndpoint: string,
  code: string,
  verifier: string,
  redirectUri: string,
  clientId: string,
  clientSecret?: string,
): Promise<TokenResult> {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  });
  if (clientSecret) params.set('client_secret', clientSecret);
  const data = await tokenRequest(tokenEndpoint, params);
  if (!data || !isString(data.access_token)) {
    throw new Error(`OAuth code exchange failed: ${describeTokenError(data)}`);
  }
  return {
    accessToken: data.access_token,
    refreshToken: isString(data.refresh_token) ? data.refresh_token : undefined,
    expiresAt: expiresAtFrom(data.expires_in),
    scope: isString(data.scope) ? data.scope : undefined,
  };
}

// Failures are discriminated so callers can tell a definitive revocation
// (invalid_grant — the refresh token is dead, re-auth is genuinely required)
// from a transient failure (network blip, 5xx, non-JSON body) that should be
// retried on the next request without scrapping the stored credential.
export type OAuthRefreshResult =
  | { ok: true; accessToken: string; refreshToken?: string; expiresAt?: string }
  | { ok: false; invalidGrant: boolean; detail: string };

export async function refreshOAuthToken(
  tokenEndpoint: string,
  refreshToken: string,
  clientId: string,
  clientSecret?: string,
): Promise<OAuthRefreshResult> {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });
  if (clientSecret) params.set('client_secret', clientSecret);
  const data = await tokenRequest(tokenEndpoint, params);
  if (!data || !isString(data.access_token)) {
    return {
      ok: false,
      invalidGrant: data?.error === 'invalid_grant',
      detail: describeTokenError(data),
    };
  }
  return {
    ok: true,
    accessToken: data.access_token,
    refreshToken: isString(data.refresh_token) ? data.refresh_token : undefined,
    expiresAt: expiresAtFrom(data.expires_in),
  };
}

export async function fetchClientCredentialsToken(
  tokenEndpoint: string,
  clientId: string,
  clientSecret: string,
  scope?: string,
): Promise<{ accessToken: string; expiresAt?: string }> {
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });
  if (scope) params.set('scope', scope);
  const data = await tokenRequest(tokenEndpoint, params);
  if (!data || !isString(data.access_token)) {
    throw new Error(`client-credentials token request failed: ${describeTokenError(data)}`);
  }
  return { accessToken: data.access_token, expiresAt: expiresAtFrom(data.expires_in) };
}
