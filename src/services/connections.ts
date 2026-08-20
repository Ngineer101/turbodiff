import {
  getConnection,
  tryClaimConnectionRefresh,
  updateConnectionAuth,
  type ConnectionAuthUpdate,
  type ConnectionRow,
} from '../data/db.ts';
import type { ConnectionSnapshot } from '../shared/connections.ts';
import { openJson, openToken, sealJson } from '../integrations/security/crypto.ts';
import { fetchClientCredentialsToken, refreshOAuthToken } from '../integrations/mcp/oauth.ts';

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
