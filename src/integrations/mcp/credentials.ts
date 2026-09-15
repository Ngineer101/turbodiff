import type { IntegrationRow } from '../../data/db.ts';
import { isJsonArray, isJsonObject, isString } from '../../shared/json.ts';
import { openToken } from '../security/crypto.ts';

export interface McpIntegrationConfig {
  url: string;
  authType: 'none' | 'bearer' | 'api_key';
  headerName: string;
  toolAllowlist: string[] | null;
}

export function mcpIntegrationConfig(integration: IntegrationRow): McpIntegrationConfig {
  if (integration.kind !== 'mcp' || !isJsonObject(integration.config)) {
    throw new Error('integration is not an MCP integration');
  }
  const url = integration.config.url;
  if (!isString(url) || !url) throw new Error('MCP integration URL is missing');
  const rawAuthType = integration.config.authType;
  const authType = rawAuthType === 'bearer' || rawAuthType === 'api_key' ? rawAuthType : 'none';
  const rawHeaderName = integration.config.headerName;
  const headerName = isString(rawHeaderName) && rawHeaderName ? rawHeaderName : 'x-api-key';
  const rawAllowlist = integration.config.toolAllowlist;
  const toolAllowlist =
    isJsonArray(rawAllowlist) && rawAllowlist.every(isString) ? rawAllowlist : null;
  return { url, authType, headerName, toolAllowlist };
}

export async function resolveMcpIntegrationAuth(
  integration: IntegrationRow,
): Promise<{ headerName: string; headerValue: string } | null> {
  const config = mcpIntegrationConfig(integration);
  if (config.authType === 'none') return null;
  if (!integration.auth_ciphertext) throw new Error('MCP integration credential is missing');
  const credential = await openToken(integration.auth_ciphertext);
  return config.authType === 'bearer'
    ? { headerName: 'authorization', headerValue: `Bearer ${credential}` }
    : { headerName: config.headerName, headerValue: credential };
}
