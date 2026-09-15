import {
  getIntegration,
  tryClaimIntegrationAuthRefresh,
  updateIntegrationAuth,
  type IntegrationRow,
} from '../../data/integrations.ts';
import {
  integrationAuthConfig,
  integrationUrl,
  type OAuthCredential,
} from '../../integrations/mcp/credentials.ts';
import {
  canonicalResourceUri,
  fetchClientCredentialsToken,
  refreshOAuthToken,
} from '../../integrations/mcp/oauth.ts';
import { openJson, openToken, sealJson } from '../../integrations/security/crypto.ts';

const TOKEN_EXPIRY_MARGIN_MS = 60_000;
const REFRESH_CLAIM_MS = 45_000;
const DEFAULT_TOKEN_TTL_MS = 60 * 60_000;

export async function resolveIntegrationAuth(
  integration: IntegrationRow,
): Promise<{ headerName: string; headerValue: string } | null> {
  const config = integrationAuthConfig(integration);
  if (config.authType === 'none') return null;
  if (!integration.auth_ciphertext) throw new Error('Integration credential is missing');
  if (config.authType === 'oauth') return resolveOAuthAuth(integration);

  const credential = await openToken(integration.auth_ciphertext);
  if (config.authType === 'bearer') {
    return { headerName: 'authorization', headerValue: `Bearer ${credential}` };
  }
  if (config.authType === 'api_key') {
    return { headerName: config.headerName, headerValue: credential };
  }
  if (!config.clientId || !config.tokenEndpoint) {
    throw new Error('Client credentials configuration is incomplete');
  }
  const token = await fetchClientCredentialsToken(
    config.tokenEndpoint,
    config.clientId,
    credential,
    config.scope ?? undefined,
    integrationUrl(integration),
  );
  return { headerName: 'authorization', headerValue: `Bearer ${token.accessToken}` };
}

async function resolveOAuthAuth(
  integration: IntegrationRow,
): Promise<{ headerName: string; headerValue: string }> {
  if (!integration.auth_ciphertext) throw new Error('OAuth is not connected');
  const credential = await openJson<OAuthCredential>(integration.auth_ciphertext);
  const expiresAt = integration.auth_expires_at
    ? new Date(integration.auth_expires_at).getTime()
    : 0;
  if (credential.accessToken && expiresAt > Date.now() + TOKEN_EXPIRY_MARGIN_MS) {
    return { headerName: 'authorization', headerValue: `Bearer ${credential.accessToken}` };
  }
  if (!credential.refreshToken) {
    await updateIntegrationAuth(
      integration.id,
      integration.auth_ciphertext,
      integration.auth_expires_at,
      true,
    );
    throw new Error('OAuth authorization must be reconnected');
  }

  const claimed = await tryClaimIntegrationAuthRefresh(
    integration.id,
    integration.auth_expires_at,
    new Date(Date.now() + REFRESH_CLAIM_MS).toISOString(),
  );
  if (!claimed) {
    const current = await getIntegration(integration.id);
    if (current?.auth_ciphertext) {
      const currentCredential = await openJson<OAuthCredential>(current.auth_ciphertext);
      if (currentCredential.accessToken) {
        return {
          headerName: 'authorization',
          headerValue: `Bearer ${currentCredential.accessToken}`,
        };
      }
    }
    throw new Error('OAuth credentials are already being refreshed');
  }

  const refreshed = await refreshOAuthToken(
    credential.tokenEndpoint,
    credential.refreshToken,
    credential.clientId,
    credential.clientSecret,
    canonicalResourceUri(integrationUrl(integration)),
  );
  if (!refreshed.ok) {
    await updateIntegrationAuth(
      integration.id,
      integration.auth_ciphertext,
      integration.auth_expires_at,
      refreshed.invalidGrant,
    );
    throw new Error(
      refreshed.invalidGrant
        ? 'OAuth authorization must be reconnected'
        : 'OAuth credentials could not be refreshed',
    );
  }

  const nextCredential: OAuthCredential = {
    ...credential,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken ?? credential.refreshToken,
  };
  await updateIntegrationAuth(
    integration.id,
    await sealJson(nextCredential),
    refreshed.expiresAt ?? new Date(Date.now() + DEFAULT_TOKEN_TTL_MS).toISOString(),
    false,
  );
  return { headerName: 'authorization', headerValue: `Bearer ${refreshed.accessToken}` };
}
