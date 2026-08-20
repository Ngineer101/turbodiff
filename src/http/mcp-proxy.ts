import type { Context } from 'hono';
import { proxyMcpRequest } from '../services/mcp-proxy.ts';

// Hono adapter for the MCP integration. Authentication, allowlisting,
// credential resolution, and upstream streaming live in the service.
export async function handleMcpProxy(context: Context): Promise<Response> {
  const method = context.req.method;
  const body = method === 'POST' ? await context.req.text() : undefined;
  return proxyMcpRequest({
    connectionId: Number(context.req.param('id')),
    authorization: context.req.header('authorization') ?? '',
    method,
    headers: context.req.raw.headers,
    body,
  });
}
