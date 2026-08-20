import type { Context } from 'hono';
import { proxyMcpRequest } from '../services/mcp-proxy.ts';

// Hono adapter for the MCP integration. Authentication, allowlisting,
// credential resolution, and upstream streaming live in the service.
export function handleMcpProxy(context: Context): Promise<Response> {
  return proxyMcpRequest(Number(context.req.param('id')), context.req.raw);
}
