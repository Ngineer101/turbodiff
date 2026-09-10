import { env } from 'cloudflare:workers';
// HTTP JSON transport for the signed-in SPA.
import { Hono } from 'hono';
import { ModelCatalogConfigurationError } from '../data/models.ts';
import { requireUser, userCanPushToRepo, userIsGithubOrgAdmin } from '../services/auth.ts';
import { dispatchExplain } from '../ai/explain/dispatch.ts';
import { createSkillsShClient } from '../integrations/skills-sh/client.ts';
import { resolveConnectionAuth } from '../services/connections.ts';
import { testMcpEndpoint } from '../integrations/mcp/client.ts';
import { enqueueFactoryMessage } from '../services/factory-queue.ts';
import { notifyInstallationsLive } from '../services/live-updates.ts';

import type { ApiEnv } from './api-support.ts';
import { deferredExecution } from './api/execution.ts';
import { registerPlatformRoutes } from './api/platform.ts';
import { registerUsageReviewRoutes } from './api/usage-reviews.ts';
import { registerBoardRoutes } from './api/board.ts';
import { registerPlanFeedbackRoutes, registerPlanRunRoutes } from './api/plans-runs.ts';
import { registerProjectRepositoryRoutes } from './api/projects-repositories.ts';
import { registerFeatureActionRoutes, registerFeatureCockpitRoutes } from './api/features.ts';
import { registerUploadTranscriptionRoutes } from './api/uploads-transcription.ts';
import { registerModelAgentRoutes } from './api/models-agents.ts';
import { registerSkillRoutes } from './api/skills.ts';
import { registerAutomationRoutes } from './api/automations.ts';
import { registerIntegrationRoutes } from './api/integrations.ts';
import { registerSettingOrganizationRoutes } from './api/settings-organizations.ts';
import type { ApiRouteDependencies, ResolvedApiRouteDependencies } from './api/types.ts';

export type { ApiRouteDependencies } from './api/types.ts';

// JSON API for the SPA (src/client). Session-cookie authed — the same
// requireUser gate as the old server-rendered pages, but failures answer
// 401 JSON instead of redirecting.
export function createApiRoutes(dependencies: ApiRouteDependencies = {}) {
  const app = new Hono<ApiEnv>();
  app.onError((error, c) => {
    if (error instanceof ModelCatalogConfigurationError) {
      return c.json({ error: error.message }, 503);
    }
    throw error;
  });
  const resolved: ResolvedApiRouteDependencies = {
    authenticate: dependencies.authenticate ?? requireUser,
    canPushToRepo: dependencies.canPushToRepo ?? userCanPushToRepo,
    orgAdmin: dependencies.orgAdmin ?? userIsGithubOrgAdmin,
    enqueueFactory: dependencies.enqueueFactory ?? enqueueFactoryMessage,
    skillsSh: dependencies.skillsSh ?? createSkillsShClient(env.SKILLS_SH_API_TOKEN),
    dispatchExplain: dependencies.dispatchExplain ?? dispatchExplain,
    resolveConnectionAuth: dependencies.resolveConnectionAuth ?? resolveConnectionAuth,
    testMcpEndpoint: dependencies.testMcpEndpoint ?? testMcpEndpoint,
  };

  // Every API response exposes its Worker time to DevTools. Slow paths emit a
  // structured event into Workers Observability with a stable 250ms budget.
  app.use('*', async (c, next) => {
    const started = performance.now();
    await next();
    const durationMs = performance.now() - started;
    if (c.res.status !== 101) {
      c.res.headers.append('server-timing', `worker;dur=${durationMs.toFixed(1)}`);
    }
    if (durationMs >= 250) {
      console.warn(
        JSON.stringify({
          event: 'api_latency_budget_exceeded',
          method: c.req.method,
          path: c.req.path,
          status: c.res.status,
          duration_ms: Math.round(durationMs),
        }),
      );
    }
  });

  // CSRF gate for the cookie-authed data plane: browsers attach Origin to
  // every POST (same-origin and cross-site alike), so a mismatched Origin is
  // a forged cross-site request regardless of cookie SameSite behavior —
  // this must not silently regress if the cookie config ever changes.
  // Requests without an Origin header pass: a non-browser client sends the
  // cookie only if it already holds it, which is not CSRF.
  const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
  app.use('*', async (c, next) => {
    if (!SAFE_METHODS.has(c.req.method)) {
      const origin = c.req.header('origin');
      if (origin && origin !== new URL(c.req.url).origin) {
        return c.json({ error: 'cross-origin request rejected' }, 403);
      }
    }
    await next();
  });

  // Successful writes publish a tiny invalidation to this user's
  // installation hubs. The RPC is deferred so mutation latency never waits
  // for connected browsers; background jobs can call the same service.
  app.use('*', async (c, next) => {
    await next();
    if (SAFE_METHODS.has(c.req.method) || c.req.path === '/performance' || c.res.status >= 400) {
      return;
    }
    deferredExecution(c).waitUntil(
      notifyInstallationsLive(c.get('user').installationIds).catch((err) => {
        console.warn('turbodiff: live write invalidation failed', err);
      }),
    );
  });

  app.use('*', async (c, next) => {
    const user = await resolved.authenticate(c.req.raw);
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    c.set('user', user);
    if (user.membershipRefresh) deferredExecution(c).waitUntil(user.membershipRefresh());
    if (user.repositoryRepair) deferredExecution(c).waitUntil(user.repositoryRepair());
    await next();
  });

  // Conditional GETs: hash the JSON body into a strong ETag and answer 304
  // to a matching If-None-Match. The server still builds the payload, but
  // polls and focus-refetches stop re-downloading (and re-rendering) bodies
  // that haven't changed — the client wrapper (src/client/lib/api.ts) keeps
  // the parsed payload alongside the etag.
  app.use('*', async (c, next) => {
    await next();
    if (c.req.method !== 'GET' || c.res.status !== 200) return;
    if (!c.res.headers.get('content-type')?.includes('application/json')) return;
    const body = await c.res.clone().arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-1', body);
    const etag = `"${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')}"`;
    if (c.req.header('if-none-match') === etag) {
      c.res = new Response(null, { status: 304, headers: { etag } });
      return;
    }
    const headers = new Headers(c.res.headers);
    headers.set('etag', etag);
    c.res = new Response(body, { status: 200, headers });
  });

  // Registration order mirrors the former monolith. In particular, skill
  // catalog/import routes remain ahead of the parameterized /skills/:id routes.
  registerPlatformRoutes(app);
  registerUsageReviewRoutes(app);
  registerBoardRoutes(app);
  registerPlanRunRoutes(app);
  registerProjectRepositoryRoutes(app, {
    canPushToRepo: resolved.canPushToRepo,
    orgAdmin: resolved.orgAdmin,
  });
  registerFeatureCockpitRoutes(app, {
    canPushToRepo: resolved.canPushToRepo,
    orgAdmin: resolved.orgAdmin,
    enqueueFactory: resolved.enqueueFactory,
    dispatchExplain: resolved.dispatchExplain,
  });
  registerUploadTranscriptionRoutes(app);
  registerPlanFeedbackRoutes(app);
  registerFeatureActionRoutes(app, {
    canPushToRepo: resolved.canPushToRepo,
    orgAdmin: resolved.orgAdmin,
    enqueueFactory: resolved.enqueueFactory,
  });
  registerModelAgentRoutes(app, { orgAdmin: resolved.orgAdmin });
  registerSkillRoutes(app, {
    orgAdmin: resolved.orgAdmin,
    skillsSh: resolved.skillsSh,
  });
  registerAutomationRoutes(app, { orgAdmin: resolved.orgAdmin });
  registerIntegrationRoutes(app, {
    orgAdmin: resolved.orgAdmin,
    resolveConnectionAuth: resolved.resolveConnectionAuth,
    testMcpEndpoint: resolved.testMcpEndpoint,
  });
  registerSettingOrganizationRoutes(app, {
    canPushToRepo: resolved.canPushToRepo,
    orgAdmin: resolved.orgAdmin,
  });

  return app;
}
