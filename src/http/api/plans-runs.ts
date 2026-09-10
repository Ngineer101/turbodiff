import type { Hono } from 'hono';
import { env } from 'cloudflare:workers';
import { getAgentRunForAuth, updatePlan } from '../../data/db.ts';
import { transcriptKey } from '../../ai/runtime/agent-runs.ts';
import { approvePlan } from '../../ai/runners/planner.ts';
import { enqueueFactoryMessage, enqueueFactoryMessages } from '../../services/factory-queue.ts';
import { isJsonArray, isString, type JsonValue } from '../../shared/json.ts';
import { type ApiPlanQuestion } from '../../shared/api-types.ts';
import { authorizedPlan, type ApiEnv } from '../api-support.ts';

export function registerPlanRunRoutes(app: Hono<ApiEnv>) {
  app.post('/factory/plans/:id/answers', async (c) => {
    const plan = await authorizedPlan(c);
    if (!plan) return c.json({ error: 'unknown plan' }, 404);
    if (plan.status !== 'awaiting_answers') {
      return c.json({ error: `plan is ${plan.status}, not awaiting answers` }, 409);
    }
    const body = await c.req.json<{ answers?: JsonValue }>().catch(() => null);
    const given = body?.answers;
    if (!isJsonArray(given)) {
      return c.json({ error: 'body must be {"answers": ["...", ...]}' }, 400);
    }
    const questions: ApiPlanQuestion[] = plan.questions ?? [];
    const answers = questions.map((_, i) => {
      const v = given[i];
      return isString(v) ? v : v == null ? '' : JSON.stringify(v);
    });
    await updatePlan(plan.id, { status: 'refining', answers });
    await enqueueFactoryMessage({ kind: 'plan_refine', planId: plan.id });
    return c.json({ ok: true });
  });

  // Re-run planning for a failed plan (transient sandbox/platform errors are
  // the common cause). A failure before the user answered anything re-runs
  // the analyze step from scratch; once answers or plan feedback exist, the
  // refine step re-runs so that input is kept. Status flips immediately so
  // the UI resumes polling without waiting on the queue.
  app.post('/factory/plans/:id/retry', async (c) => {
    const plan = await authorizedPlan(c);
    if (!plan) return c.json({ error: 'unknown plan' }, 404);
    if (plan.status !== 'failed') {
      return c.json({ error: `plan is ${plan.status}, not retryable` }, 409);
    }
    const feedback: unknown[] = plan.feedback ? JSON.parse(plan.feedback) : [];
    const refine = plan.answers !== null || feedback.length > 0;
    await updatePlan(plan.id, { status: refine ? 'refining' : 'analyzing' });
    await enqueueFactoryMessage(
      refine ? { kind: 'plan_refine', planId: plan.id } : { kind: 'plan_analyze', planId: plan.id },
    );
    return c.json({ ok: true });
  });

  app.post('/factory/plans/:id/approve', async (c) => {
    const plan = await authorizedPlan(c);
    if (!plan) return c.json({ error: 'unknown plan' }, 404);
    const { session } = c.get('user');
    // The approver authors the generated commit (src/domain/attribution.ts).
    const featureIds = await approvePlan(plan.id, { login: session.login, id: session.userId });
    if (featureIds === null) return c.json({ error: 'plan is not ready for approval' }, 409);
    // One independent feature per repo — generation runs fully in parallel.
    await enqueueFactoryMessages(featureIds.map((featureId) => ({ kind: 'generate', featureId })));
    return c.json({ ok: true, feature_ids: featureIds });
  });

  // Full agent-session transcript for one run (plan analyze/refine, generate,
  // verify, fix). Session-authed rather than the public signed /artifacts/*
  // capability route — a full agent transcript is more sensitive than a
  // screenshot, so it's gated by installation ownership like every other
  // factory read here.
  app.get('/factory/runs/:id/log', async (c) => {
    const id = Number(c.req.param('id'));
    const run = Number.isInteger(id) ? await getAgentRunForAuth(id) : null;
    if (!run || !c.get('user').installationIds.includes(run.installationId)) {
      return c.json({ error: 'unknown run' }, 404);
    }
    const object = await env.ARTIFACTS.get(run.logKey);
    if (!object) return c.json({ error: 'log no longer available' }, 404);
    return c.json({ log: await object.text() });
  });

  // Raw OpenCode event transcript for one run — every completed tool, model
  // step, and narrative part, not just the final result. Served raw (not
  // JSON-wrapped): transcripts
  // are large and this is jq food, not UI copy. Same auth gate as the log.
  app.get('/factory/runs/:id/transcript', async (c) => {
    const id = Number(c.req.param('id'));
    const run = Number.isInteger(id) ? await getAgentRunForAuth(id) : null;
    if (!run || !c.get('user').installationIds.includes(run.installationId)) {
      return c.json({ error: 'unknown run' }, 404);
    }
    const object = await env.ARTIFACTS.get(transcriptKey(run.logKey));
    if (!object) {
      return c.json({ error: 'no transcript for this run (pre-dates transcript capture)' }, 404);
    }
    return c.body(object.body, 200, { 'content-type': 'application/x-ndjson' });
  });
}

export function registerPlanFeedbackRoutes(app: Hono<ApiEnv>) {
  // Batched plan-review feedback: snippet-anchored comments collected in the
  // UI, submitted once, and consumed by a revise (plan_refine) run.
  app.post('/factory/plans/:id/feedback', async (c) => {
    const plan = await authorizedPlan(c);
    if (!plan) return c.json({ error: 'unknown plan' }, 404);
    if (plan.status !== 'plan_ready') {
      return c.json({ error: `plan is ${plan.status}, not ready for feedback` }, 409);
    }
    const body = await c.req
      .json<{ comments?: { snippet?: unknown; comment?: unknown }[] }>()
      .catch(() => null);
    const raw = Array.isArray(body?.comments) ? body.comments : [];
    const comments = raw
      .map((f) => ({
        snippet: isString(f.snippet) ? f.snippet.trim().slice(0, 300) : '',
        comment: isString(f.comment) ? f.comment.trim().slice(0, 1000) : '',
      }))
      .filter((f) => f.comment)
      .slice(0, 20);
    if (comments.length === 0) return c.json({ error: 'at least one comment is required' }, 400);
    await updatePlan(plan.id, { status: 'refining', feedback: JSON.stringify(comments) });
    await enqueueFactoryMessage({ kind: 'plan_refine', planId: plan.id });
    return c.json({ ok: true, comments: comments.length });
  });
}
