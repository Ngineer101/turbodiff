import { env } from 'cloudflare:workers';
import {
  automationHasIntegration,
  getIntegration,
  repositoryHasIntegration,
  type IntegrationRow,
} from '../../data/db.ts';
import { isJsonObject, isNumber, isString, parseJson, type JsonValue } from '../../shared/json.ts';
import { encryptionConfigured, openJson, sealJson } from '../security/crypto.ts';
import { mcpIntegrationConfig, resolveMcpIntegrationAuth } from './credentials.ts';

interface McpProxyGrant {
  integrationId: number;
  repositoryId: number;
  automationId?: number;
  exp: number;
}

export const MCP_PROXY_GRANT_TTL_MS = 60 * 60_000;

export async function mintMcpProxyGrant(
  integrationId: number,
  repositoryId: number,
  automationId?: number,
): Promise<string> {
  const grant: McpProxyGrant = {
    integrationId,
    repositoryId,
    exp: Date.now() + MCP_PROXY_GRANT_TTL_MS,
  };
  if (automationId) grant.automationId = automationId;
  return sealJson(grant);
}

async function verifyGrant(token: string, integrationId: number): Promise<McpProxyGrant | null> {
  try {
    const grant = await openJson<McpProxyGrant>(token);
    return grant.integrationId === integrationId && grant.exp > Date.now() ? grant : null;
  } catch {
    return null;
  }
}

const FORWARDED_REQUEST_HEADERS = [
  'content-type',
  'accept',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
];
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'mcp-session-id', 'mcp-protocol-version'];

function jsonRpcError(id: JsonValue, message: string): Response {
  return Response.json({
    jsonrpc: '2.0',
    id: isString(id) || isNumber(id) ? id : null,
    error: { code: -32602, message },
  });
}

function blockedToolResponse(integration: IntegrationRow, body: string): Response | null {
  const allowed = mcpIntegrationConfig(integration).toolAllowlist;
  if (!allowed) return null;
  let rpc: JsonValue;
  try {
    rpc = parseJson(body);
  } catch {
    return null;
  }
  for (const entry of Array.isArray(rpc) ? rpc : [rpc]) {
    if (!isJsonObject(entry) || entry.method !== 'tools/call' || !isJsonObject(entry.params)) {
      continue;
    }
    const tool = entry.params.name;
    if (isString(tool) && !allowed.includes(tool)) {
      return jsonRpcError(entry.id ?? null, `tool "${tool}" is not allowed`);
    }
  }
  return null;
}

export async function proxyMcpRequest(integrationId: number, request: Request): Promise<Response> {
  if (!Number.isInteger(integrationId) || integrationId <= 0) {
    return Response.json({ error: 'not found' }, { status: 404 });
  }
  const authorization = request.headers.get('authorization') ?? '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const grant = token ? await verifyGrant(token, integrationId) : null;
  if (!grant) return Response.json({ error: 'invalid or expired grant' }, { status: 401 });

  const integration = await getIntegration(integrationId);
  const authorized =
    (await repositoryHasIntegration(grant.repositoryId, integrationId)) ||
    (grant.automationId
      ? await automationHasIntegration(grant.automationId, integrationId)
      : false);
  if (!integration || integration.kind !== 'mcp' || !integration.enabled || !authorized) {
    return Response.json({ error: 'not found' }, { status: 404 });
  }
  const config = mcpIntegrationConfig(integration);
  const body = request.method === 'POST' ? await request.text() : undefined;
  if (body !== undefined) {
    const blocked = blockedToolResponse(integration, body);
    if (blocked) return blocked;
  }

  let auth: Awaited<ReturnType<typeof resolveMcpIntegrationAuth>>;
  try {
    auth = await resolveMcpIntegrationAuth(integration);
  } catch (error) {
    console.error(`turbodiff: MCP integration ${integration.id} credential failed`, error);
    return Response.json({ error: 'integration credential unavailable' }, { status: 502 });
  }
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (auth) headers.set(auth.headerName, auth.headerValue);
  const upstream = await fetch(config.url, { method: request.method, headers, body });
  const responseHeaders = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

export interface SandboxMcpConfig {
  configJson: string;
  secrets: string[];
}

export interface SandboxMcpBinding {
  integration: IntegrationRow;
  repositoryId: number;
  automationId?: number;
}

function serverName(integration: IntegrationRow): string {
  return (
    integration.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || `integration-${integration.id}`
  );
}

export async function buildSandboxMcpConfig(
  bindings: readonly SandboxMcpBinding[],
): Promise<SandboxMcpConfig | null> {
  if (bindings.length === 0 || !encryptionConfigured()) return null;
  const servers: Record<
    string,
    {
      type: 'remote';
      url: string;
      enabled: true;
      oauth: false;
      headers: { Authorization: string };
    }
  > = {};
  const secrets: string[] = [];
  for (const { integration, repositoryId, automationId } of bindings) {
    if (integration.kind !== 'mcp' || !integration.enabled) continue;
    const name = serverName(integration);
    if (servers[name]) continue;
    const grant = await mintMcpProxyGrant(integration.id, repositoryId, automationId);
    secrets.push(grant);
    servers[name] = {
      type: 'remote',
      url: `${env.PUBLIC_BASE_URL}/mcp-proxy/${integration.id}`,
      enabled: true,
      oauth: false,
      headers: { Authorization: `Bearer ${grant}` },
    };
  }
  return Object.keys(servers).length > 0
    ? { configJson: JSON.stringify({ mcp: servers }), secrets }
    : null;
}
