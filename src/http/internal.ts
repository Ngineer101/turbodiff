import { createAgentRouter } from '@flue/runtime/routing';
import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { PrReviewer } from '../ai/agents/pr-reviewer.ts';
import { runFix, sandboxSmoke, type FixAuthMode } from '../ai/runners/fixer.ts';
import { approvePlan } from '../ai/runners/planner.ts';
import {
  createFeature,
  createPlan,
  failStrandedGeneration,
  getFeature,
  getPlan,
  getRepoByFullName,
  setRepoCheckCommand,
  setRepoRunCommand,
  updateFeature,
  updatePlan,
} from '../data/db.ts';
import { timingSafeEqual } from '../integrations/security/crypto.ts';
import { isString } from '../shared/json.ts';
import { enqueueFactoryMessage, enqueueFactoryMessages } from '../services/factory-queue.ts';
import { factoryUnsupportedReason } from '../integrations/git/provider.ts';
import {
  createArtifactsProject,
  mintArtifactsCloneToken,
  PROJECT_SEGMENT,
} from '../services/artifacts.ts';

// Shared-secret operator surface. This transport owns validation and queue
// admission; durable AI work remains in runners/workflows.
export function createInternalRoutes() {
  const routes = new Hono();
  const reviewer = createAgentRouter(PrReviewer);
  // Operator endpoints keep the shared secret (Authorization: Bearer <REVIEW_SECRET>).
  const requireSecret = createMiddleware(async (c, next) => {
    const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    if (!env.REVIEW_SECRET || !(await timingSafeEqual(token, env.REVIEW_SECRET))) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
  });
  // The agent conversation surface (debugging: GET /internal/pr-reviewer/<instance-id>
  // returns the durable conversation incl. settlements). Lives under /internal
  // because the signed-in UI owns /agents.
  routes.use('/*', requireSecret);

  routes.route('/pr-reviewer', reviewer);

  // Artifacts-hosted project provisioning (docs/artifacts-provider.md):
  //   POST /projects { "owner": "...", "name": "...", "description"?: "..." }
  // Creates the Artifacts repo in turbodiff's namespace, seeds an initial
  // commit, and records the synthetic-tenancy PostgreSQL rows. The request stays
  // open for the provisioning (first call pays a container boot).
  routes.post('/projects', async (c) => {
    const payload = await c.req
      .json<{ owner?: string; name?: string; description?: string }>()
      .catch(() => null);
    if (
      !payload ||
      !isString(payload.owner) ||
      !PROJECT_SEGMENT.test(payload.owner) ||
      !isString(payload.name) ||
      !PROJECT_SEGMENT.test(payload.name)
    ) {
      return c.json(
        { error: 'body must be {"owner": "...", "name": "...", "description"?: "..."}' },
        400,
      );
    }
    const existing = await getRepoByFullName(payload.owner, payload.name);
    if (existing) return c.json({ error: `${payload.owner}/${payload.name} already exists` }, 409);
    try {
      const project = await createArtifactsProject({
        owner: payload.owner,
        name: payload.name,
        description: isString(payload.description) ? payload.description : undefined,
      });
      return c.json({
        ok: true,
        repository_id: project.repo.id,
        repo: `${project.repo.owner}/${project.repo.name}`,
        provider: project.repo.provider,
        artifacts_repo: project.repo.artifacts_repo,
        default_branch: project.repo.default_branch,
        remote: project.remote,
      });
    } catch (err) {
      console.error('turbodiff: project provisioning failed:', err);
      return c.json({ error: err instanceof Error ? err.message : 'provisioning failed' }, 502);
    }
  });

  // Clone credential for an Artifacts-hosted repo — the deploy-key
  // replacement that lets a user clone/push with plain git:
  //   POST /repos/clone-token { "repo": "<owner>/<name>", "scope"?: "read" | "write", "ttl_seconds"?: n }
  routes.post('/repos/clone-token', async (c) => {
    const payload = await c.req
      .json<{ repo?: string; scope?: string; ttl_seconds?: number }>()
      .catch(() => null);
    const match = payload?.repo?.match(/^([\w.-]+)\/([\w.-]+)$/);
    if (!match) return c.json({ error: 'body must be {"repo": "<owner>/<name>", ...}' }, 400);
    const scope = payload?.scope === 'write' ? 'write' : 'read';
    const requestedTtl = payload?.ttl_seconds;
    const ttl =
      requestedTtl !== undefined && Number.isInteger(requestedTtl)
        ? Math.min(Math.max(requestedTtl, 60), 30 * 24 * 3600)
        : 24 * 3600;
    const repo = await getRepoByFullName(match[1], match[2]);
    if (!repo) return c.json({ error: `unknown repository ${payload?.repo}` }, 404);
    try {
      return c.json(await mintArtifactsCloneToken(repo, scope, ttl));
    } catch (err) {
      console.error('turbodiff: clone-token mint failed:', err);
      return c.json({ error: err instanceof Error ? err.message : 'token mint failed' }, 502);
    }
  });

  // Software-factory fix loop, Phase 1 spike (docs/software-factory-design.md):
  //   POST /fix { "pr_url": "...", "findings"?: "...", "auth_mode"?: "...", "test_command"?: "..." }
  // Clones the PR head branch in a sandbox, runs the fix agent against the
  // findings (default: turbodiff's latest blocking review), runs tests, pushes.
  // The request stays open for the duration of the run (minutes).
  // Sandbox health probe: boots the fixer container and reports toolchain
  // versions. No GitHub access, no model spend.
  routes.get('/fix/smoke', async (c) => {
    try {
      // ?auth=1 additionally runs a one-line agent prompt with the resolved
      // runner credential (tiny model spend) to verify auth end to end.
      return c.json(await sandboxSmoke(c.req.query('auth') === '1'));
    } catch (err) {
      console.error('turbodiff: sandbox smoke failed:', err);
      return c.json({ error: err instanceof Error ? err.message : 'smoke failed' }, 502);
    }
  });

  // Software-factory generation, Phase 2 (docs/software-factory-design.md):
  //   POST /generate { "repo": "<owner>/<name>", "title": "...", "spec": "..." }
  // Records the feature and enqueues the generation run; the generated PR then
  // flows through the normal review + auto-fix loop. Poll the status route below.
  routes.post('/generate', async (c) => {
    const payload = await c.req
      .json<{ repo?: string; title?: string; spec?: string }>()
      .catch(() => null);
    const match = payload?.repo?.match(/^([\w.-]+)\/([\w.-]+)$/);
    if (!match || !payload?.title?.trim() || !payload?.spec?.trim()) {
      return c.json(
        { error: 'body must be {"repo": "<owner>/<name>", "title": "...", "spec": "..."}' },
        400,
      );
    }
    const repo = await getRepoByFullName(match[1], match[2]);
    if (!repo) return c.json({ error: `Turbodiff is not installed on ${payload.repo}` }, 404);
    if (!repo.enabled) return c.json({ error: 'reviews are disabled for this repository' }, 409);

    const featureId = await createFeature(repo.id, payload.title.trim(), payload.spec.trim());
    await enqueueFactoryMessage({ kind: 'generate', featureId });
    return c.json({
      accepted: true,
      feature_id: featureId,
      status_url: `/internal/features/${featureId}`,
    });
  });

  // Software-factory planning intake, Phase 3 (docs/software-factory-design.md).
  // The full front half: requirements → clarifying questions → plan + acceptance
  // criteria → approve → generation.
  //   POST /plans { "repo": "<owner>/<name>", "title": "...", "requirements": "..." }
  // Records the plan and enqueues analysis; poll the status route for questions.
  routes.post('/plans', async (c) => {
    const payload = await c.req
      .json<{ repo?: string; title?: string; requirements?: string }>()
      .catch(() => null);
    const match = payload?.repo?.match(/^([\w.-]+)\/([\w.-]+)$/);
    if (!match || !payload?.title?.trim() || !payload?.requirements?.trim()) {
      return c.json(
        { error: 'body must be {"repo": "<owner>/<name>", "title": "...", "requirements": "..."}' },
        400,
      );
    }
    const repo = await getRepoByFullName(match[1], match[2]);
    if (!repo) return c.json({ error: `Turbodiff is not installed on ${payload.repo}` }, 404);
    if (!repo.enabled) return c.json({ error: 'reviews are disabled for this repository' }, 409);

    const planId = await createPlan([repo.id], payload.title.trim(), payload.requirements.trim());
    await enqueueFactoryMessage({ kind: 'plan_analyze', planId });
    return c.json({ accepted: true, plan_id: planId, status_url: `/internal/plans/${planId}` });
  });

  routes.get('/plans/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const plan = Number.isInteger(id) ? await getPlan(id) : null;
    if (!plan) return c.json({ error: 'unknown plan' }, 404);
    return c.json(plan);
  });

  // Submit answers to the clarifying questions; enqueues plan refinement.
  routes.post('/plans/:id/answers', async (c) => {
    const id = Number(c.req.param('id'));
    const plan = Number.isInteger(id) ? await getPlan(id) : null;
    if (!plan) return c.json({ error: 'unknown plan' }, 404);
    if (plan.status !== 'awaiting_answers') {
      return c.json({ error: `plan is ${plan.status}, not awaiting_answers` }, 409);
    }
    const payload = await c.req.json<{ answers?: unknown }>().catch(() => null);
    if (!Array.isArray(payload?.answers)) {
      return c.json({ error: 'body must be {"answers": ["...", ...]}' }, 400);
    }
    await updatePlan(id, {
      status: 'refining',
      answers: payload.answers.map(String),
    });
    await enqueueFactoryMessage({ kind: 'plan_refine', planId: id });
    return c.json({ accepted: true, plan_id: id, status_url: `/internal/plans/${id}` });
  });

  // Approve a ready plan: converts it to a generation feature (spec = plan +
  // acceptance criteria) and enqueues generation.
  routes.post('/plans/:id/approve', async (c) => {
    const id = Number(c.req.param('id'));
    const featureIds = await approvePlan(id);
    if (featureIds === null) {
      return c.json({ error: 'plan not found or not in plan_ready state' }, 409);
    }
    await enqueueFactoryMessages(featureIds.map((featureId) => ({ kind: 'generate', featureId })));
    return c.json({
      accepted: true,
      plan_id: id,
      feature_ids: featureIds,
      status_url: `/internal/features/${featureIds[0]}`,
    });
  });

  // Set the sandbox verification gate for a repo (dashboard field lives in
  // settings; this is the operator/API path). Empty command clears the gate.
  // How the verify step launches this repo's app for runtime/visual checks
  // (Phase 4). Empty command disables runtime verification for the repo.
  routes.post('/repos/run-command', async (c) => {
    const payload = await c.req
      .json<{ repo?: string; command?: string; port?: number }>()
      .catch(() => null);
    const match = payload?.repo?.match(/^([\w.-]+)\/([\w.-]+)$/);
    if (!payload || !match || !isString(payload.command)) {
      return c.json(
        { error: 'body must be {"repo": "<owner>/<name>", "command": "...", "port": 3000}' },
        400,
      );
    }
    const port = payload.port !== undefined && Number.isInteger(payload.port) ? payload.port : null;
    if (payload.command.trim() && !port) {
      return c.json({ error: 'port is required when command is set' }, 400);
    }
    const repo = await getRepoByFullName(match[1], match[2]);
    if (!repo) return c.json({ error: `Turbodiff is not installed on ${payload.repo}` }, 404);
    await setRepoRunCommand(repo.id, payload.command, port);
    return c.json({
      ok: true,
      repo: payload.repo,
      run_command: payload.command.trim() || null,
      app_port: port,
    });
  });

  routes.post('/repos/check-command', async (c) => {
    const payload = await c.req.json<{ repo?: string; command?: string }>().catch(() => null);
    const match = payload?.repo?.match(/^([\w.-]+)\/([\w.-]+)$/);
    if (!payload || !match || !isString(payload.command)) {
      return c.json({ error: 'body must be {"repo": "<owner>/<name>", "command": "..."}' }, 400);
    }
    const repo = await getRepoByFullName(match[1], match[2]);
    if (!repo) return c.json({ error: `Turbodiff is not installed on ${payload.repo}` }, 404);
    await setRepoCheckCommand(repo.id, payload.command);
    return c.json({ ok: true, repo: payload.repo, check_command: payload.command.trim() || null });
  });

  routes.get('/features/:id', async (c) => {
    await failStrandedGeneration();
    const id = Number(c.req.param('id'));
    const feature = Number.isInteger(id) ? await getFeature(id) : null;
    if (!feature) return c.json({ error: 'unknown feature' }, 404);
    return c.json(feature);
  });

  // Operator re-verification: enqueue a fresh verify run for a feature.
  routes.post('/features/:id/verify', async (c) => {
    const id = Number(c.req.param('id'));
    const feature = Number.isInteger(id) ? await getFeature(id) : null;
    if (!feature) return c.json({ error: 'unknown feature' }, 404);
    if (!feature.pr_number || !feature.acceptance) {
      return c.json({ error: 'feature has no PR or no acceptance criteria' }, 409);
    }
    await enqueueFactoryMessage({ kind: 'verify', featureId: id });
    return c.json({ accepted: true, feature_id: id });
  });

  // Operator retry for a failed generation: re-enqueues the SAME feature row,
  // preserving its spec and commit attribution (unlike /generate,
  // which would mint a fresh unattributed feature). An optional
  // {"delay_seconds": n} defers delivery (e.g. to ride out a platform
  // incident); the feature stays in its failed state until the run actually
  // starts, so the strand sweep can't misfire during the wait.
  routes.post('/features/:id/retry', async (c) => {
    await failStrandedGeneration();
    const id = Number(c.req.param('id'));
    const feature = Number.isInteger(id) ? await getFeature(id) : null;
    if (!feature) return c.json({ error: 'unknown feature' }, 404);
    const RETRYABLE = new Set(['failed', 'checks_failed', 'no_changes']);
    if (!RETRYABLE.has(feature.status)) {
      return c.json({ error: `feature is ${feature.status}, not retryable` }, 409);
    }
    const body = await c.req.json<{ delay_seconds?: number }>().catch(() => null);
    const delay = Math.min(Math.max(Math.floor(body?.delay_seconds ?? 0), 0), 12 * 3600);
    // The workflow's first step flips status to 'generating' — pre-setting it
    // here would trip startGeneration's in-flight guard.
    if (delay > 0) {
      await updateFeature(id, { error: `retry scheduled in ${Math.round(delay / 60)}m` });
      await enqueueFactoryMessage({ kind: 'generate', featureId: id }, { delaySeconds: delay });
    } else {
      await updateFeature(id, { error: 'retry queued' });
      await enqueueFactoryMessage({ kind: 'generate', featureId: id });
    }
    return c.json({
      accepted: true,
      feature_id: id,
      delay_seconds: delay,
      status_url: `/internal/features/${id}`,
    });
  });

  routes.post('/fix', async (c) => {
    const payload = await c.req
      .json<{
        pr_url?: string;
        findings?: string;
        auth_mode?: FixAuthMode;
        test_command?: string;
      }>()
      .catch(() => null);
    const match = payload?.pr_url?.match(
      /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/,
    );
    if (!match) {
      return c.json(
        { error: 'body must be {"pr_url": "https://github.com/<owner>/<repo>/pull/<n>", ...}' },
        400,
      );
    }
    const [, owner, repoName, number] = match;
    const repo = await getRepoByFullName(owner, repoName);
    if (!repo) {
      return c.json({ error: `Turbodiff is not installed on ${owner}/${repoName}` }, 404);
    }
    const fixUnsupported = factoryUnsupportedReason(repo);
    if (fixUnsupported) return c.json({ error: fixUnsupported }, 409);
    try {
      const outcome = await runFix({
        owner: repo.owner,
        repo: repo.name,
        prNumber: Number(number),
        installationId: repo.installation_id,
        repositoryId: repo.id,
        findings: payload?.findings,
        authMode: payload?.auth_mode,
        testCommand: payload?.test_command ?? repo.check_command ?? undefined,
      });
      return c.json(outcome);
    } catch (err) {
      console.error(`turbodiff: fix run failed for ${owner}/${repoName}#${number}:`, err);
      return c.json({ error: err instanceof Error ? err.message : 'fix run failed' }, 502);
    }
  });

  return routes;
}
