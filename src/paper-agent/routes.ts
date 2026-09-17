// HTTP surface for the Paper design agent.
//
// A self-contained transport mounted at /paper (like /protocol and /mcp), not
// part of the Effect JSON data plane. Session-authenticated; each job is scoped
// to the caller's active organization.
//
//   POST /paper/jobs                 create a job, returns the DesignJob
//   GET  /paper/jobs/:id             inspect a job
//   POST /paper/jobs/:id/resume      re-queue a paused/failed job
//   GET  /paper/jobs/:id/live-view   session id + Live View URL for auth

import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { requireUser, type AuthedUser } from '../application/auth/session.ts';
import { isJsonObject, isString, parseJson } from '../shared/json.ts';
import type { DesignJob } from './types.ts';

type PaperEnv = { Variables: { user: AuthedUser } };

const MAX_OBJECTIVE_LENGTH = 2000;

function jobStub(id: string) {
  return env.DESIGN_JOB.get(env.DESIGN_JOB.idFromName(id));
}

export function createPaperRoutes(authenticate: typeof requireUser = requireUser) {
  const app = new Hono<PaperEnv>();

  app.use('*', async (context, next) => {
    const user = await authenticate(context.req.raw);
    if (!user) return context.json({ error: 'unauthorized' }, 401);
    context.set('user', user);

    // Reject cross-origin state-changing requests (the session cookie is the
    // only credential), mirroring the /protocol transport.
    const origin = context.req.header('origin');
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(context.req.method) &&
      origin &&
      origin !== new URL(context.req.url).origin
    ) {
      return context.json({ error: 'cross-origin request rejected' }, 403);
    }
    await next();
  });

  app.post('/jobs', async (context) => {
    const user = context.get('user');
    if (user.organizationIds.length === 0) {
      return context.json({ error: 'an organization is required to create a design job' }, 403);
    }

    const raw = await context.req.text();
    const body = raw ? parseJson(raw) : null;
    if (!isJsonObject(body)) {
      return context.json({ error: 'JSON body required' }, 400);
    }
    const mode = body.mode === 'design' ? 'design' : body.mode === 'read' ? 'read' : undefined;
    const rawObjective = isString(body.objective) ? body.objective.trim() : '';
    // Read mode (the default) needs no objective; design mode requires one.
    if ((mode ?? 'read') === 'design' && !rawObjective) {
      return context.json({ error: 'objective is required for design mode' }, 400);
    }
    if (rawObjective.length > MAX_OBJECTIVE_LENGTH) {
      return context.json({ error: `objective exceeds ${MAX_OBJECTIVE_LENGTH} characters` }, 400);
    }
    const objective = rawObjective || 'Read the existing Paper design and prove it is readable';
    const paperUrl = isString(body.paperUrl) ? body.paperUrl.trim() : undefined;
    const model = isString(body.model) ? body.model.trim() : undefined;
    const sessionId = isString(body.sessionId) ? body.sessionId.trim() : undefined;

    const id = crypto.randomUUID();
    try {
      const job = await jobStub(id).create({
        objective,
        organizationId: user.activeOrganizationId,
        authUserId: user.session.authUserId,
        paperUrl,
        model,
        mode,
        sessionId,
      });
      return context.json(job, 201);
    } catch (error) {
      // resolvePaperUrl throws when no Paper URL is configured or supplied.
      return context.json(
        { error: error instanceof Error ? error.message : 'failed to create job' },
        400,
      );
    }
  });

  app.get('/jobs/:id', async (context) => {
    const job = await authorizedJob(context.req.param('id'), context.get('user'));
    if (!job) return context.json({ error: 'unknown job' }, 404);
    return context.json(job);
  });

  app.post('/jobs/:id/resume', async (context) => {
    const id = context.req.param('id');
    const existing = await authorizedJob(id, context.get('user'));
    if (!existing) return context.json({ error: 'unknown job' }, 404);
    const job = await jobStub(id).resume();
    return context.json(job);
  });

  app.get('/jobs/:id/live-view', async (context) => {
    const id = context.req.param('id');
    const existing = await authorizedJob(id, context.get('user'));
    if (!existing) return context.json({ error: 'unknown job' }, 404);
    return context.json(await jobStub(id).liveView());
  });

  return app;
}

/** Load a job only if it belongs to one of the caller's organizations. */
async function authorizedJob(id: string | undefined, user: AuthedUser): Promise<DesignJob | null> {
  if (!id) return null;
  const job = await jobStub(id).snapshot();
  if (!job || !user.organizationIds.includes(job.organizationId)) return null;
  return job;
}
