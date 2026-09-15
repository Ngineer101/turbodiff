import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { requireUser } from '../application/auth/session.ts';
import {
  completeIntegrationOAuth,
  startIntegrationOAuth,
} from '../application/integrations/oauth.ts';
import { getIntegration } from '../data/integrations.ts';
import { integrationAuthConfig } from '../integrations/mcp/credentials.ts';

async function authorizedIntegration(request: Request, rawId: string) {
  const user = await requireUser(request);
  if (!user) return null;
  const id = Number(rawId);
  const integration = Number.isSafeInteger(id) && id > 0 ? await getIntegration(id) : null;
  return integration && user.organizationIds.includes(integration.organization_id)
    ? integration
    : null;
}

export function createIntegrationOAuthRoutes() {
  const routes = new Hono();

  routes.get('/:id/oauth/start', async (context) => {
    const integration = await authorizedIntegration(context.req.raw, context.req.param('id'));
    if (!integration) return context.json({ error: 'unknown integration' }, 404);
    if (integration.kind !== 'mcp' || integrationAuthConfig(integration).authType !== 'oauth') {
      return context.json({ error: 'integration does not use MCP OAuth' }, 400);
    }
    const result = await startIntegrationOAuth(
      integration,
      env.PUBLIC_BASE_URL,
      env.SESSION_SECRET,
    );
    return context.redirect(
      result.ok
        ? result.authorizeUrl
        : `/integrations?oauth=error&reason=${encodeURIComponent(result.reason)}`,
    );
  });

  routes.get('/:id/oauth/callback', async (context) => {
    const integration = await authorizedIntegration(context.req.raw, context.req.param('id'));
    if (!integration) return context.json({ error: 'unknown integration' }, 404);
    const providerError = context.req.query('error');
    if (providerError) {
      return context.redirect(
        `/integrations?oauth=error&reason=${encodeURIComponent(providerError)}`,
      );
    }
    const code = context.req.query('code');
    const state = context.req.query('state');
    if (!code || !state) return context.redirect('/integrations?oauth=error&reason=missing_code');
    const result = await completeIntegrationOAuth(
      integration,
      code,
      state,
      env.PUBLIC_BASE_URL,
      env.SESSION_SECRET,
    );
    return context.redirect(
      result.ok
        ? `/integrations?oauth=connected&name=${encodeURIComponent(integration.name)}`
        : `/integrations?oauth=error&reason=${encodeURIComponent(result.reason)}`,
    );
  });

  return routes;
}
