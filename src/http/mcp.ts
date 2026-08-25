import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { handleMcpPost } from '../integrations/mcp/server.ts';
import { requireMcpUser } from '../services/auth.ts';
import { enqueueFactoryMessage } from '../services/factory-queue.ts';

// Inbound MCP endpoint (turbodiff.dev/mcp): OAuth 2.1 bearer auth resolved by
// requireMcpUser, protocol handling in integrations/mcp/server.ts. Stateless
// streamable HTTP — POST only; there is no SSE stream to GET and no session
// to DELETE (both 405s are spec-permitted). Deliberately no CORS middleware
// and no Origin gate: bearer-authed, non-browser MCP hosts are the audience —
// browser-based hosts are an explicit non-goal.

export interface McpRouteDependencies {
  authenticate?: typeof requireMcpUser;
  // Injectable for tests (the worker-test fixture has no queue binding).
  enqueueFactory?: typeof enqueueFactoryMessage;
}

export function createMcpRoutes(dependencies: McpRouteDependencies = {}): Hono {
  const app = new Hono();
  const authenticate = dependencies.authenticate ?? requireMcpUser;
  const enqueue = dependencies.enqueueFactory ?? enqueueFactoryMessage;

  app.post('/', async (c) => {
    const user = await authenticate(c.req.raw);
    if (!user) {
      // The resource_metadata pointer is how MCP hosts (Claude Code,
      // claude.ai) discover the authorization server — load-bearing, not
      // decorative (MCP authorization spec, RFC 9728).
      c.header(
        'www-authenticate',
        `Bearer resource_metadata="${env.PUBLIC_BASE_URL}/.well-known/oauth-protected-resource"`,
      );
      return c.json({ error: 'unauthorized' }, 401);
    }
    return handleMcpPost(c.req.raw, user, { enqueue });
  });

  app.on(['GET', 'DELETE'], '/', (c) => {
    c.header('allow', 'POST');
    return c.json({ error: 'method not allowed' }, 405);
  });

  return app;
}
