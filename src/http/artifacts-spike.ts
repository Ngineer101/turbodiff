import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { runArtifactsSpike, SPIKE_REPO_NAME } from '../ai/runners/artifacts-spike.ts';
import { listArtifactsEvents } from '../services/artifacts-events.ts';

// Phase-0 Cloudflare Artifacts spike surface (docs/artifacts-spike.md).
// Mounted under /internal/artifacts-spike, behind the operator shared secret.
export function createArtifactsSpikeRoutes() {
  const routes = new Hono();

  // Full E2E probe: create repo → tokens → sandbox push/clone → revoke.
  // The request stays open for the run (~a minute after first container boot).
  //   POST /run { "name"?: "spike-..." }
  routes.post('/run', async (c) => {
    const payload = await c.req.json<{ name?: string }>().catch(() => null);
    const name = payload?.name;
    if (name !== undefined && !SPIKE_REPO_NAME.test(name)) {
      return c.json({ error: `name must match ${SPIKE_REPO_NAME}` }, 400);
    }
    try {
      return c.json(await runArtifactsSpike(name));
    } catch (err) {
      console.error('turbodiff: artifacts spike run failed:', err);
      return c.json({ error: err instanceof Error ? err.message : 'spike run failed' }, 502);
    }
  });

  routes.get('/repos', async (c) => {
    try {
      return c.json(await env.GIT_ARTIFACTS.list());
    } catch (err) {
      console.error('turbodiff: artifacts repo list failed:', err);
      return c.json({ error: err instanceof Error ? err.message : 'list failed' }, 502);
    }
  });

  routes.delete('/repos/:name', async (c) => {
    const name = c.req.param('name');
    if (!SPIKE_REPO_NAME.test(name)) {
      return c.json({ error: `name must match ${SPIKE_REPO_NAME}` }, 400);
    }
    try {
      const deleted = await env.GIT_ARTIFACTS.delete(name);
      return c.json({ deleted }, deleted ? 200 : 404);
    } catch (err) {
      console.error('turbodiff: artifacts repo delete failed:', err);
      return c.json({ error: err instanceof Error ? err.message : 'delete failed' }, 502);
    }
  });

  // Raw event-subscription messages captured off the factory queue
  // (src/services/artifacts-events.ts). Empty until the queue subscriptions
  // are created — see docs/artifacts-spike.md.
  routes.get('/events', async (c) => {
    return c.json({ events: await listArtifactsEvents() });
  });

  return routes;
}
