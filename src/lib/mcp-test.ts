import { isJsonArray, isJsonObject, isString, parseJson, type JsonObject } from '../shared/json.ts';

// Best-effort MCP streamable-HTTP handshake backing the "test" button on
// agent connections: initialize → notifications/initialized → tools/list.
// Reports the server identity and discovered tool names without mounting
// anything; failures come back as text, never throws.

export interface McpTestResult {
  ok: boolean;
  detail: string;
  tools?: string[];
}

// The JSON-RPC requests this probe sends.
type McpRpcRequest = {
  jsonrpc: '2.0';
  id?: number;
  method: string;
  params?: JsonObject;
};

// Streamable-HTTP servers may answer application/json or a one-shot SSE
// stream; accept both. A JSON-RPC response envelope is always an object.
function parseRpcBody(text: string): JsonObject | null {
  const candidates =
    text.startsWith('data:') || text.includes('\ndata:')
      ? text
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
      : [text];
  for (const c of candidates) {
    try {
      const parsed = parseJson(c);
      if (isJsonObject(parsed)) return parsed;
    } catch {
      // try the next SSE data line
    }
  }
  return null;
}

function rpcErrorMessage(body: JsonObject): string | null {
  const error = body['error'];
  return isJsonObject(error) && isString(error['message']) ? error['message'] : null;
}

export async function testMcpEndpoint(
  url: string,
  auth?: { headerName: string; headerValue: string },
): Promise<McpTestResult> {
  const baseHeaders = new Headers({
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  });
  if (auth) baseHeaders.set(auth.headerName, auth.headerValue);
  const rpc = (body: McpRpcRequest, session?: string | null) => {
    const headers = new Headers(baseHeaders);
    if (session) headers.set('mcp-session-id', session);
    return fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  };

  let initRes: Response;
  try {
    initRes = await rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'turbodiff', version: '1.0.0' },
      },
    });
  } catch (err) {
    return {
      ok: false,
      detail: `could not reach server: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!initRes.ok) {
    return {
      ok: false,
      detail: `HTTP ${initRes.status} ${initRes.statusText}: ${(await initRes.text()).slice(0, 300)}`,
    };
  }

  const session = initRes.headers.get('mcp-session-id');
  const init = parseRpcBody(await initRes.text());
  if (!init || init['error']) {
    const message = init ? rpcErrorMessage(init) : null;
    return {
      ok: false,
      detail: `initialize failed: ${message ?? 'unparseable response'}`,
    };
  }
  const initResult = init['result'];
  const serverInfo = isJsonObject(initResult) ? initResult['serverInfo'] : undefined;
  let identity = 'server';
  if (isJsonObject(serverInfo)) {
    const name = serverInfo['name'];
    const version = serverInfo['version'];
    if (isString(name) && name) {
      identity = isString(version) && version ? `${name} v${version}` : name;
    }
  }

  // Handshake courtesy + tool discovery; a failure here still counts as a
  // reachable, authenticated server.
  try {
    await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, session);
    const listRes = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, session);
    const list = parseRpcBody(await listRes.text());
    const listResult = list ? list['result'] : undefined;
    const rawTools = isJsonObject(listResult) ? listResult['tools'] : undefined;
    if (isJsonArray(rawTools)) {
      const tools = rawTools.map((t) => (isJsonObject(t) ? t['name'] : undefined)).filter(isString);
      return { ok: true, detail: `connected to ${identity}; ${tools.length} tools`, tools };
    }
  } catch {
    // fall through to the initialize-only success
  }
  return { ok: true, detail: `connected to ${identity} (tool list unavailable)` };
}
