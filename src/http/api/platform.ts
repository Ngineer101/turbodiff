import type { Hono } from 'hono';
import { env } from 'cloudflare:workers';
import { deletePushSubscriptionByEndpoint, upsertPushSubscription } from '../../data/db.ts';
import { isJsonObject, isNumber, isString, type JsonObject } from '../../shared/json.ts';
import { type ApiMe } from '../../shared/api-types.ts';
import { type ApiEnv } from '../api-support.ts';

export function registerPlatformRoutes(app: Hono<ApiEnv>) {
  app.get('/me', (c) => {
    const user = c.get('user');
    return c.json<ApiMe>({
      login: user.githubConnected ? user.session.login : null,
      name: user.name,
      github_connected: user.githubConnected,
      github_status: user.githubStatus,
      github_app_slug: env.GITHUB_APP_SLUG,
      vapid_public_key: env.VAPID_PUBLIC_KEY,
      installation_ids: user.installationIds,
    });
  });

  app.get('/live/:installationId', async (c) => {
    const installationId = Number(c.req.param('installationId'));
    const origin = c.req.header('origin');
    if (origin && origin !== new URL(c.req.url).origin) {
      return c.json({ error: 'cross-origin websocket rejected' }, 403);
    }
    if (
      !Number.isInteger(installationId) ||
      !c.get('user').installationIds.includes(installationId)
    ) {
      return c.json({ error: 'unknown installation' }, 404);
    }
    return await env.LIVE_UPDATES.getByName(String(installationId)).fetch(c.req.raw);
  });

  app.post('/performance', async (c) => {
    const body = await c.req.json<JsonObject>().catch(() => null);
    if (!body || !isString(body.path) || !isJsonObject(body.metrics)) {
      return c.json({ error: 'invalid performance sample' }, 400);
    }
    const allowed = new Set(['ttfb', 'dom_interactive', 'lcp', 'inp', 'cls']);
    const metrics = Object.fromEntries(
      Object.entries(body.metrics).filter(
        ([name, value]) => allowed.has(name) && isNumber(value) && Number.isFinite(value),
      ),
    );
    console.log(
      JSON.stringify({
        event: 'client_performance',
        path: body.path.slice(0, 160),
        metrics,
      }),
    );
    return c.json({ ok: true });
  });

  // Web Push subscription (src/services/push-notifications.ts). Body shape matches
  // PushSubscription.toJSON() natively — no client-side reshaping needed.
  app.post('/push/subscribe', async (c) => {
    const user = c.get('user');
    if (!user.githubConnected || user.session.userId <= 0) {
      return c.json({ error: 'connect GitHub before enabling push notifications' }, 409);
    }
    const body = await c.req
      .json<{ endpoint?: string; keys?: { p256dh?: string; auth?: string } }>()
      .catch(() => null);
    const endpoint = body?.endpoint?.trim() ?? '';
    const p256dh = body?.keys?.p256dh?.trim() ?? '';
    const auth = body?.keys?.auth?.trim() ?? '';
    if (!endpoint || !p256dh || !auth) {
      return c.json({ error: 'body must be {"endpoint", "keys": {"p256dh", "auth"}}' }, 400);
    }
    await upsertPushSubscription(user.session.userId, { endpoint, p256dh, auth });
    return c.json({ ok: true });
  });

  app.post('/push/unsubscribe', async (c) => {
    const body = await c.req.json<{ endpoint?: string }>().catch(() => null);
    const endpoint = body?.endpoint?.trim() ?? '';
    if (!endpoint) return c.json({ error: 'body must be {"endpoint"}' }, 400);
    await deletePushSubscriptionByEndpoint(c.get('user').session.userId, endpoint);
    return c.json({ ok: true });
  });
}
