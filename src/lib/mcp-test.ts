// Best-effort MCP streamable-HTTP handshake backing the "test" button on
// agent connections: initialize → notifications/initialized → tools/list.
// Reports the server identity and discovered tool names without mounting
// anything; failures come back as text, never throws.

export interface McpTestResult {
  ok: boolean;
  detail: string;
  tools?: string[];
}

// Streamable-HTTP servers may answer application/json or a one-shot SSE
// stream; accept both.
function parseRpcBody(text: string): { result?: unknown; error?: { message?: string } } | null {
  const candidates =
    text.startsWith('data:') || text.includes('\ndata:')
      ? text
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
      : [text];
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      // try the next SSE data line
    }
  }
  return null;
}

export async function testMcpEndpoint(url: string, token?: string): Promise<McpTestResult> {
  const baseHeaders: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  const rpc = (body: object, session?: string | null) =>
    fetch(url, {
      method: 'POST',
      headers: { ...baseHeaders, ...(session ? { 'mcp-session-id': session } : {}) },
      body: JSON.stringify(body),
    });

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
  if (!init || init.error) {
    return {
      ok: false,
      detail: `initialize failed: ${init?.error?.message ?? 'unparseable response'}`,
    };
  }
  const serverInfo = (init.result as { serverInfo?: { name?: string; version?: string } })
    ?.serverInfo;
  const identity = serverInfo?.name
    ? `${serverInfo.name}${serverInfo.version ? ` v${serverInfo.version}` : ''}`
    : 'server';

  // Handshake courtesy + tool discovery; a failure here still counts as a
  // reachable, authenticated server.
  try {
    await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, session);
    const listRes = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, session);
    const list = parseRpcBody(await listRes.text());
    const tools = (list?.result as { tools?: { name?: string }[] })?.tools
      ?.map((t) => t.name)
      .filter((n): n is string => typeof n === 'string');
    if (tools) {
      return { ok: true, detail: `connected to ${identity}; ${tools.length} tools`, tools };
    }
  } catch {
    // fall through to the initialize-only success
  }
  return { ok: true, detail: `connected to ${identity} (tool list unavailable)` };
}
