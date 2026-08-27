import { env } from 'cloudflare:workers';
import {
  getConnection,
  tryClaimConnectionRefresh,
  updateConnectionAuth,
  type ConnectionAuthUpdate,
  type ConnectionRow,
} from '../data/db.ts';
import type { ConnectionSnapshot } from '../shared/connections.ts';
import { openJson, openToken, sealJson } from '../integrations/security/crypto.ts';
import {
  canonicalResourceUri,
  discoverOAuthEndpoints,
  exchangeAuthorizationCode,
  fetchClientCredentialsToken,
  generatePkce,
  packState,
  refreshOAuthToken,
  registerOAuthClient,
  unpackState,
} from '../integrations/mcp/oauth.ts';

export interface ResolvedAuth {
  headerName: string;
  headerValue: string;
}

interface ClientCredentialsConfig {
  clientId: string;
  clientSecret: string;
  tokenEndpoint: string;
  scope?: string;
  accessToken?: string;
  expiresAt?: string;
}

interface OAuthConfig {
  clientId: string;
  clientSecret?: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationClientUri?: string;
  accessToken?: string;
  refreshToken?: string;
  scope?: string;
}

const TOKEN_EXPIRY_MARGIN_MS = 60_000;
const REFRESH_CLAIM_MS = 45_000;
const DEFAULT_TOKEN_TTL_MS = 60 * 60_000;

function stillFresh(expiresAt: string | null | undefined): boolean {
  return !!expiresAt && new Date(expiresAt).getTime() > Date.now() + TOKEN_EXPIRY_MARGIN_MS;
}

// The safe, non-secret snapshot that may cross into an agent delivery.
export function connectionSnapshot(row: ConnectionRow): ConnectionSnapshot {
  let tools: string[] | undefined;
  if (row.tool_allowlist) {
    try {
      const parsed = JSON.parse(row.tool_allowlist);
      if (Array.isArray(parsed) && parsed.length > 0) tools = parsed.map(String);
    } catch {
      // Malformed allowlist behaves as "all tools" rather than failing runs.
    }
  }
  const snapshot: ConnectionSnapshot = {
    id: row.id,
    name: row.name,
    url: row.url,
    hasAuth: row.auth_type !== 'none',
    authType: row.auth_type,
    optional: row.optional === 1,
  };
  if (tools) snapshot.tools = tools;
  return snapshot;
}

// Resolves and refreshes connection credentials. External OAuth calls and
// encryption are application/integration concerns, not persistence concerns.
export async function resolveConnectionAuth(conn: ConnectionRow): Promise<ResolvedAuth | null> {
  switch (conn.auth_type) {
    case 'bearer':
      return conn.auth_ciphertext
        ? {
            headerName: 'authorization',
            headerValue: `Bearer ${await openToken(conn.auth_ciphertext)}`,
          }
        : null;
    case 'api_key':
      return conn.auth_config_ciphertext
        ? openJson<ResolvedAuth>(conn.auth_config_ciphertext)
        : null;
    case 'client_credentials':
      return resolveClientCredentials(conn);
    case 'oauth':
      return resolveOAuthConnection(conn);
    case 'none':
    default:
      return null;
  }
}

async function resolveClientCredentials(conn: ConnectionRow): Promise<ResolvedAuth | null> {
  if (!conn.auth_config_ciphertext) return null;
  const config = await openJson<ClientCredentialsConfig>(conn.auth_config_ciphertext);
  if (config.accessToken && stillFresh(config.expiresAt)) {
    return { headerName: 'authorization', headerValue: `Bearer ${config.accessToken}` };
  }
  const token = await fetchClientCredentialsToken(
    config.tokenEndpoint,
    config.clientId,
    config.clientSecret,
    config.scope,
    canonicalResourceUri(conn.url),
  );
  await updateConnectionAuth(conn.id, {
    authConfigCiphertext: await sealJson<ClientCredentialsConfig>({
      ...config,
      accessToken: token.accessToken,
      expiresAt: token.expiresAt,
    }),
  });
  return { headerName: 'authorization', headerValue: `Bearer ${token.accessToken}` };
}

async function resolveOAuthConnection(conn: ConnectionRow): Promise<ResolvedAuth> {
  if (!conn.auth_config_ciphertext) {
    throw new Error(
      `turbodiff: connection ${conn.id} has no OAuth credential yet — connect it from the integrations page`,
    );
  }
  const config = await openJson<OAuthConfig>(conn.auth_config_ciphertext);
  if (config.accessToken && stillFresh(conn.oauth_token_expires_at)) {
    return { headerName: 'authorization', headerValue: `Bearer ${config.accessToken}` };
  }
  if (!config.refreshToken) {
    await updateConnectionAuth(conn.id, { oauthNeedsReauth: true, oauthHasRefreshToken: false });
    throw new Error(
      `turbodiff: connection ${conn.id}'s OAuth token expired and has no refresh token — reconnect it from the integrations page`,
    );
  }

  const claimed = await tryClaimConnectionRefresh(
    conn.id,
    conn.oauth_token_expires_at,
    new Date(Date.now() + REFRESH_CLAIM_MS).toISOString(),
  );
  if (!claimed) {
    const fresh = await getConnection(conn.id);
    const freshConfig = fresh?.auth_config_ciphertext
      ? await openJson<OAuthConfig>(fresh.auth_config_ciphertext)
      : null;
    if (freshConfig?.accessToken) {
      return { headerName: 'authorization', headerValue: `Bearer ${freshConfig.accessToken}` };
    }
    throw new Error(`turbodiff: connection ${conn.id}'s OAuth refresh is in flight — retry`);
  }

  const refreshed = await refreshOAuthToken(
    config.tokenEndpoint,
    config.refreshToken,
    config.clientId,
    config.clientSecret,
    canonicalResourceUri(conn.url),
  );
  if (!refreshed.ok) {
    if (refreshed.invalidGrant) {
      await updateConnectionAuth(conn.id, { oauthNeedsReauth: true });
      throw new Error(
        `turbodiff: connection ${conn.id}'s OAuth refresh token was revoked (${refreshed.detail}) — reconnect it from the integrations page`,
      );
    }
    throw new Error(
      `turbodiff: connection ${conn.id}'s OAuth refresh failed (${refreshed.detail}) — will retry`,
    );
  }

  const update: ConnectionAuthUpdate = {
    authConfigCiphertext: await sealJson<OAuthConfig>({
      ...config,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken ?? config.refreshToken,
    }),
    oauthNeedsReauth: false,
    oauthHasRefreshToken: true,
    oauthTokenExpiresAt:
      refreshed.expiresAt ?? new Date(Date.now() + DEFAULT_TOKEN_TTL_MS).toISOString(),
  };
  await updateConnectionAuth(conn.id, update);
  return { headerName: 'authorization', headerValue: `Bearer ${refreshed.accessToken}` };
}

// The same config blob while the connect flow is still building it up:
// /oauth/start's registration fills clientId/clientSecret and refreshes the
// endpoints, and the callback adds the tokens — after which it reads as the
// full OAuthConfig that resolveOAuthConnection consumes.
type OAuthConfigDraft = Partial<OAuthConfig>;

function oauthRedirectUri(connectionId: number): string {
  return `${env.PUBLIC_BASE_URL}/api/integrations/${connectionId}/oauth/callback`;
}

export type OAuthConnectStart =
  | { ok: true; authorizeUrl: string }
  | { ok: false; reason: 'discovery_failed' | 'no_registration_endpoint' | 'registration_failed' };

// Begin the authorization-code connect flow for an MCP integration: discover
// the server's OAuth endpoints, dynamically register a client when none is
// stored yet, persist the (re-)discovered endpoints, and produce the
// authorization URL to send the browser to. The HTTP layer only maps the
// result onto redirects.
export async function startOAuthConnect(conn: ConnectionRow): Promise<OAuthConnectStart> {
  const redirectUri = oauthRedirectUri(conn.id);
  let endpoints: Awaited<ReturnType<typeof discoverOAuthEndpoints>>;
  try {
    endpoints = await discoverOAuthEndpoints(conn.url);
  } catch (err) {
    console.error(`turbodiff: oauth discovery failed for connection ${conn.id}:`, err);
    return { ok: false, reason: 'discovery_failed' };
  }

  let cache: OAuthConfigDraft = conn.auth_config_ciphertext
    ? await openJson<OAuthConfigDraft>(conn.auth_config_ciphertext)
    : {};
  let clientId = cache.clientId;
  if (!clientId) {
    if (!endpoints.registrationEndpoint) {
      return { ok: false, reason: 'no_registration_endpoint' };
    }
    try {
      const registered = await registerOAuthClient(endpoints.registrationEndpoint, redirectUri, {
        clientName: 'turbodiff',
        clientUri: env.PUBLIC_BASE_URL,
        authMethodsSupported: endpoints.tokenEndpointAuthMethodsSupported,
      });
      clientId = registered.clientId;
      cache = { ...cache, clientId, clientSecret: registered.clientSecret };
    } catch (err) {
      console.error(`turbodiff: oauth client registration failed for connection ${conn.id}:`, err);
      return { ok: false, reason: 'registration_failed' };
    }
  }
  // Re-registering on every connect click would be wasteful, but the
  // discovered endpoints are cheap to refresh each time so the callback
  // always exchanges against the server's current metadata.
  cache = {
    ...cache,
    authorizationEndpoint: endpoints.authorizationEndpoint,
    tokenEndpoint: endpoints.tokenEndpoint,
  };
  await updateConnectionAuth(conn.id, { authConfigCiphertext: await sealJson(cache) });

  const { verifier, challenge } = await generatePkce();
  const state = await packState({ connectionId: conn.id, verifier }, env.SESSION_SECRET);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    // RFC 8707, required by the MCP spec on authorization and token
    // requests alike, whether or not the server supports it.
    resource: canonicalResourceUri(conn.url),
  });
  // Request the server's advertised scopes — some issue refresh tokens
  // only when the authorization request names a scope (offline_access).
  if (endpoints.scopesSupported?.length) {
    params.set('scope', endpoints.scopesSupported.join(' '));
  }
  return { ok: true, authorizeUrl: `${endpoints.authorizationEndpoint}?${params.toString()}` };
}

export type OAuthConnectResult =
  | { ok: true }
  | { ok: false; reason: 'invalid_state' | 'not_started' | 'exchange_failed' };

// Complete the connect flow: validate the signed state, exchange the code
// against the endpoints persisted by startOAuthConnect, and store the tokens.
export async function completeOAuthConnect(
  conn: ConnectionRow,
  code: string,
  state: string,
): Promise<OAuthConnectResult> {
  const unpacked = await unpackState(state, env.SESSION_SECRET);
  if (!unpacked || unpacked.connectionId !== conn.id) {
    return { ok: false, reason: 'invalid_state' };
  }

  const cache = conn.auth_config_ciphertext
    ? await openJson<OAuthConfigDraft>(conn.auth_config_ciphertext)
    : null;
  if (!cache?.clientId || !cache.tokenEndpoint) {
    return { ok: false, reason: 'not_started' };
  }

  let tokens: Awaited<ReturnType<typeof exchangeAuthorizationCode>>;
  try {
    tokens = await exchangeAuthorizationCode(
      cache.tokenEndpoint,
      code,
      unpacked.verifier,
      oauthRedirectUri(conn.id),
      cache.clientId,
      cache.clientSecret,
      canonicalResourceUri(conn.url),
    );
  } catch (err) {
    console.error(`turbodiff: oauth code exchange failed for connection ${conn.id}:`, err);
    return { ok: false, reason: 'exchange_failed' };
  }

  await updateConnectionAuth(conn.id, {
    authConfigCiphertext: await sealJson<OAuthConfigDraft>({
      ...cache,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      scope: tokens.scope,
    }),
    oauthNeedsReauth: false,
    oauthHasRefreshToken: tokens.refreshToken !== undefined,
    // Always record an expiry: a null column can never be advanced by the
    // COALESCE-based update, which would force a refresh on every request.
    oauthTokenExpiresAt:
      tokens.expiresAt ?? new Date(Date.now() + DEFAULT_TOKEN_TTL_MS).toISOString(),
  });
  return { ok: true };
}

export function oauthStatus(
  conn: ConnectionRow,
): 'not_connected' | 'connected' | 'expired' | 'needs_reauth' | null {
  if (conn.auth_type !== 'oauth') return null;
  if (conn.oauth_needs_reauth === 1) return 'needs_reauth';
  if (conn.auth_config_ciphertext === null) return 'not_connected';
  if (
    conn.oauth_has_refresh_token !== 1 &&
    conn.oauth_token_expires_at &&
    new Date(conn.oauth_token_expires_at).getTime() < Date.now()
  ) {
    return 'expired';
  }
  return 'connected';
}
