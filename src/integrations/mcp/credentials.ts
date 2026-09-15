import type { IntegrationRow } from '../../data/integrations.ts';
import { isJsonArray, isJsonObject, isString } from '../../shared/json.ts';

export type IntegrationAuthType = 'none' | 'bearer' | 'api_key' | 'client_credentials' | 'oauth';

export interface McpIntegrationConfig {
  url: string;
  authType: IntegrationAuthType;
  headerName: string;
  toolAllowlist: string[] | null;
}

export interface IntegrationAuthConfig {
  authType: IntegrationAuthType;
  headerName: string;
  clientId: string | null;
  tokenEndpoint: string | null;
  scope: string | null;
}

export interface OAuthCredential {
  clientId: string;
  clientSecret?: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  accessToken?: string;
  refreshToken?: string;
  scope?: string;
}

export function integrationAuthConfig(integration: IntegrationRow): IntegrationAuthConfig {
  if (!isJsonObject(integration.config)) throw new Error('Integration config is invalid');
  const rawAuthType = integration.config.authType;
  if (
    rawAuthType !== 'none' &&
    rawAuthType !== 'bearer' &&
    rawAuthType !== 'api_key' &&
    rawAuthType !== 'client_credentials' &&
    rawAuthType !== 'oauth'
  ) {
    const label = isString(rawAuthType) ? rawAuthType : '(missing)';
    throw new Error(`Integration auth type ${label} is not supported`);
  }
  const rawHeaderName = integration.config.headerName;
  return {
    authType: rawAuthType,
    headerName: isString(rawHeaderName) && rawHeaderName ? rawHeaderName : 'x-api-key',
    clientId: isString(integration.config.clientId) ? integration.config.clientId : null,
    tokenEndpoint: isString(integration.config.tokenEndpoint)
      ? integration.config.tokenEndpoint
      : null,
    scope: isString(integration.config.scope) ? integration.config.scope : null,
  };
}

export function mcpIntegrationConfig(integration: IntegrationRow): McpIntegrationConfig {
  if (integration.kind !== 'mcp' || !isJsonObject(integration.config)) {
    throw new Error('integration is not an MCP integration');
  }
  const url = integration.config.url;
  if (!isString(url) || !url) throw new Error('MCP integration URL is missing');
  const { authType, headerName } = integrationAuthConfig(integration);
  const rawAllowlist = integration.config.toolAllowlist;
  const toolAllowlist =
    isJsonArray(rawAllowlist) && rawAllowlist.every(isString) ? rawAllowlist : null;
  return { url, authType, headerName, toolAllowlist };
}

export function integrationUrl(integration: IntegrationRow): string {
  if (!isJsonObject(integration.config) || !isString(integration.config.url)) {
    throw new Error('Integration URL is missing');
  }
  return integration.config.url;
}
