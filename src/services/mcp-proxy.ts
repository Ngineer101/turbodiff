import { env } from 'cloudflare:workers';
import { isJsonObject, isNumber, isString, parseJson, type JsonValue } from '../shared/json.ts';
import { encryptionConfigured, openJson, sealJson } from '../integrations/security/crypto.ts';
import { getConnection, type ConnectionRow } from '../data/db.ts';
import { connectionSnapshot, resolveConnectionAuth } from './connections.ts';

// MCP relay for sandbox runs: the sandbox agent's MCP config points every
// server at /mcp-proxy/:id with a short-lived sealed grant as its bearer
// token, and this handler injects the connection's real credential per
// request. Auth material keeps the same property as hosted review mounts —
// it never leaves the Worker/D1 boundary, so a prompt-injected repo can at
// worst use the connection for the grant's lifetime, never exfiltrate its
// credential.

interface McpProxyGrant {
  connectionId: number;
  repositoryId: number;
  exp: number; // epoch ms
}

// Outlives the automation agent step timeout (23 minutes) with margin for a
// retried step reusing the same config file.
export const MCP_PROXY_GRANT_TTL_MS = 60 * 60_000;

export async function mintMcpProxyGrant(
  connectionId: number,
  repositoryId: number,
): Promise<string> {
  return sealJson<McpProxyGrant>({
    connectionId,
    repositoryId,
    exp: Date.now() + MCP_PROXY_GRANT_TTL_MS,
  });
}

async function verifyGrant(token: string, connectionId: number): Promise<boolean> {
  try {
    const grant = await openJson<McpProxyGrant>(token);
    return grant.connectionId === connectionId && grant.exp > Date.now();
  } catch {
    // Forged or truncated tokens fail AES-GCM authentication and land here.
    return false;
  }
}

// Streamable-HTTP MCP requests/responses carry framing state in these
// headers; everything else (cookies, the sandbox's grant) stops at the proxy.
const FORWARDED_REQUEST_HEADERS = [
  'content-type',
  'accept',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
];
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'mcp-session-id', 'mcp-protocol-version'];

function jsonRpcError(id: JsonValue, message: string): Response {
  const rpcId = isString(id) || isNumber(id) ? id : null;
  return Response.json({
    jsonrpc: '2.0',
    id: rpcId,
    error: { code: -32602, message },
  });
}

// Enforce the connection's tool allowlist at the only place the sandbox can
// invoke a tool. tools/list responses are relayed unfiltered (streaming SSE
// makes rewriting them fragile), so a disallowed tool may be visible but any
// call to it is rejected here. Legacy JSON-RPC batches are checked entry by
// entry so a batched call cannot slip past the gate.
function blockedToolResponse(conn: ConnectionRow, body: string): Response | null {
  const allowed = connectionSnapshot(conn).tools;
  if (!allowed) return null;
  let rpc: JsonValue;
  try {
    rpc = parseJson(body);
  } catch {
    return null; // not JSON — let the upstream server reject it
  }
  const requests = Array.isArray(rpc) ? rpc : [rpc];
  for (const entry of requests) {
    if (!isJsonObject(entry) || entry.method !== 'tools/call' || !isJsonObject(entry.params)) {
      continue;
    }
    const tool = entry.params.name;
    if (isString(tool) && !allowed.includes(tool)) {
      return jsonRpcError(entry.id ?? null, `tool "${tool}" is not in this connection's allowlist`);
    }
  }
  return null;
}

export interface McpProxyRequest {
  connectionId: number;
  authorization: string;
  method: string;
  headers: Headers;
  body?: string;
}

export async function proxyMcpRequest(request: McpProxyRequest): Promise<Response> {
  const { connectionId } = request;
  if (!Number.isInteger(connectionId) || connectionId <= 0) {
    return Response.json({ error: 'not found' }, { status: 404 });
  }
  const token = request.authorization.startsWith('Bearer ')
    ? request.authorization.slice('Bearer '.length)
    : '';
  if (!token || !(await verifyGrant(token, connectionId))) {
    return Response.json({ error: 'invalid or expired grant' }, { status: 401 });
  }
  const conn = await getConnection(connectionId);
  if (!conn || conn.kind !== 'mcp') {
    return Response.json({ error: 'not found' }, { status: 404 });
  }

  if (request.method === 'POST' && request.body !== undefined) {
    const blocked = blockedToolResponse(conn, request.body);
    if (blocked) return blocked;
  }

  let auth: Awaited<ReturnType<typeof resolveConnectionAuth>>;
  try {
    auth = await resolveConnectionAuth(conn);
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'could not resolve credentials';
    return Response.json({ error: detail }, { status: 502 });
  }

  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (auth) headers.set(auth.headerName, auth.headerValue);

  const upstream = await fetch(conn.url, {
    method: request.method,
    headers,
    body: request.body,
  });
  const responseHeaders = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  // Pass the body stream through untouched so SSE responses keep streaming.
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

// The MCP config for one sandbox run: every attached connection routed
// through the proxy with its own grant. Returns null when there is nothing to
// mount, or when no TOKEN_ENCRYPTION_KEY is configured (grants cannot be
// minted without it). `secrets` lists the grants for log scrubbing.
export interface SandboxMcpConfig {
  configJson: string;
  secrets: string[];
}

function serverName(conn: ConnectionRow): string {
  const slug = conn.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || `connection-${conn.id}`;
}

export async function buildSandboxMcpConfig(
  connections: ConnectionRow[],
  repositoryId: number,
): Promise<SandboxMcpConfig | null> {
  if (connections.length === 0) return null;
  if (!encryptionConfigured()) {
    console.warn(
      'turbodiff: skipping MCP mounts for sandbox run — TOKEN_ENCRYPTION_KEY is not configured',
    );
    return null;
  }
  const servers: {
    [name: string]: { type: 'http'; url: string; headers: { [h: string]: string } };
  } = {};
  const secrets: string[] = [];
  for (const conn of connections) {
    const grant = await mintMcpProxyGrant(conn.id, repositoryId);
    secrets.push(grant);
    servers[serverName(conn)] = {
      type: 'http',
      url: `${env.PUBLIC_BASE_URL}/mcp-proxy/${conn.id}`,
      headers: { Authorization: `Bearer ${grant}` },
    };
  }
  return { configJson: JSON.stringify({ mcpServers: servers }), secrets };
}
