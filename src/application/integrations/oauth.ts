import type { IntegrationRow } from '../../data/integrations.ts';
import { updateIntegrationAuth } from '../../data/integrations.ts';
import {
  canonicalResourceUri,
  discoverOAuthEndpoints,
  exchangeAuthorizationCode,
  generatePkce,
  packState,
  registerOAuthClient,
  unpackState,
} from '../../integrations/mcp/oauth.ts';
import { openJson, sealJson } from '../../integrations/security/crypto.ts';
import {
  integrationAuthConfig,
  integrationUrl,
  type OAuthCredential,
} from '../../integrations/mcp/credentials.ts';

type OAuthDraft = Partial<OAuthCredential>;

export type OAuthStartResult =
  | { readonly ok: true; readonly authorizeUrl: string }
  | {
      readonly ok: false;
      readonly reason: 'discovery_failed' | 'no_registration_endpoint' | 'registration_failed';
    };

export type OAuthCompleteResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'invalid_state' | 'not_started' | 'exchange_failed';
    };

const redirectUri = (baseUrl: string, integrationId: number) =>
  `${baseUrl}/api/integrations/${integrationId}/oauth/callback`;

export async function startIntegrationOAuth(
  integration: IntegrationRow,
  baseUrl: string,
  sessionSecret: string,
): Promise<OAuthStartResult> {
  if (integration.kind !== 'mcp' || integrationAuthConfig(integration).authType !== 'oauth') {
    throw new Error('Integration does not use MCP OAuth');
  }
  const callback = redirectUri(baseUrl, integration.id);
  let endpoints: Awaited<ReturnType<typeof discoverOAuthEndpoints>>;
  try {
    endpoints = await discoverOAuthEndpoints(integrationUrl(integration));
  } catch (error) {
    console.error(`turbodiff: OAuth discovery failed for integration ${integration.id}`, error);
    return { ok: false, reason: 'discovery_failed' };
  }

  let draft: OAuthDraft = integration.auth_ciphertext
    ? await openJson<OAuthDraft>(integration.auth_ciphertext)
    : {};
  let clientId = draft.clientId;
  if (!clientId) {
    if (!endpoints.registrationEndpoint) {
      return { ok: false, reason: 'no_registration_endpoint' };
    }
    try {
      const registered = await registerOAuthClient(endpoints.registrationEndpoint, callback, {
        clientName: 'turbodiff',
        clientUri: baseUrl,
        authMethodsSupported: endpoints.tokenEndpointAuthMethodsSupported,
      });
      clientId = registered.clientId;
      draft = { ...draft, clientId, clientSecret: registered.clientSecret };
    } catch (error) {
      console.error(
        `turbodiff: OAuth registration failed for integration ${integration.id}`,
        error,
      );
      return { ok: false, reason: 'registration_failed' };
    }
  }

  draft = {
    ...draft,
    authorizationEndpoint: endpoints.authorizationEndpoint,
    tokenEndpoint: endpoints.tokenEndpoint,
  };
  await updateIntegrationAuth(integration.id, await sealJson(draft), null, false);

  const { verifier, challenge } = await generatePkce();
  const state = await packState({ connectionId: integration.id, verifier }, sessionSecret);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: callback,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    resource: canonicalResourceUri(integrationUrl(integration)),
  });
  if (endpoints.scopesSupported?.length) {
    params.set('scope', endpoints.scopesSupported.join(' '));
  }
  return { ok: true, authorizeUrl: `${endpoints.authorizationEndpoint}?${params.toString()}` };
}

export async function completeIntegrationOAuth(
  integration: IntegrationRow,
  code: string,
  state: string,
  baseUrl: string,
  sessionSecret: string,
): Promise<OAuthCompleteResult> {
  const unpacked = await unpackState(state, sessionSecret);
  if (!unpacked || unpacked.connectionId !== integration.id) {
    return { ok: false, reason: 'invalid_state' };
  }
  const draft = integration.auth_ciphertext
    ? await openJson<OAuthDraft>(integration.auth_ciphertext)
    : null;
  if (!draft?.clientId || !draft.tokenEndpoint || !draft.authorizationEndpoint) {
    return { ok: false, reason: 'not_started' };
  }

  let tokens: Awaited<ReturnType<typeof exchangeAuthorizationCode>>;
  try {
    tokens = await exchangeAuthorizationCode(
      draft.tokenEndpoint,
      code,
      unpacked.verifier,
      redirectUri(baseUrl, integration.id),
      draft.clientId,
      draft.clientSecret,
      canonicalResourceUri(integrationUrl(integration)),
    );
  } catch (error) {
    console.error(`turbodiff: OAuth exchange failed for integration ${integration.id}`, error);
    return { ok: false, reason: 'exchange_failed' };
  }

  const credential: OAuthCredential = {
    clientId: draft.clientId,
    clientSecret: draft.clientSecret,
    authorizationEndpoint: draft.authorizationEndpoint,
    tokenEndpoint: draft.tokenEndpoint,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    scope: tokens.scope,
  };
  await updateIntegrationAuth(
    integration.id,
    await sealJson(credential),
    tokens.expiresAt ?? new Date(Date.now() + 60 * 60_000).toISOString(),
    false,
  );
  return { ok: true };
}
