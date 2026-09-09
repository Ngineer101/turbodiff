import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { testMcpEndpoint } from './client.ts';

describe('testMcpEndpoint OAuth failures', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports an authorization rejection that happens during tool discovery', async () => {
    const responses = [
      Response.json(
        {
          jsonrpc: '2.0',
          id: 1,
          result: { serverInfo: { name: 'cloudflare', version: '1.0' } },
        },
        { headers: { 'mcp-session-id': 'session-1' } },
      ),
      new Response(null, { status: 202 }),
      new Response('token expired', { status: 401, statusText: 'Unauthorized' }),
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => responses.shift() ?? new Response(null, { status: 500 })),
    );

    await expect(testMcpEndpoint('https://mcp.cloudflare.com/mcp')).resolves.toEqual({
      ok: false,
      detail: 'HTTP 401 Unauthorized: token expired',
      status: 401,
    });
  });
});
