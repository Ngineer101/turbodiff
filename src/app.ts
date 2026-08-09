import { dispatch, setProvider } from '@flue/runtime';
import { cloudflareBindingProvider } from '@flue/runtime/cloudflare/workers-ai';
import { createAgentRouter } from '@flue/runtime/routing';
import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { PrReviewer } from './agents/pr-reviewer.ts';
import { timingSafeEqual, verifyArtifactSig } from './lib/crypto.ts';
import {
	connectionSnapshot,
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
	listAgentConnections,
	recordReview,
	type AgentRow,
	type RepositoryRow,
} from './lib/db.ts';
import { runFix, sandboxSmoke, type FixAuthMode } from './lib/fixer.ts';
import { approvePlan } from './lib/planner.ts';
import { registerReviewMetering } from './lib/metering.ts';
import { createApiRoutes } from './routes/api.ts';
import { createUiRoutes } from './routes/ui.ts';
import { createWebhookRoutes } from './routes/webhooks.ts';

// Route every model call through the Workers AI binding and the named
// AI Gateway (set AI_GATEWAY_ID in wrangler.jsonc). The gateway holds the
// provider keys (BYOK) — no ANTHROPIC_API_KEY ever enters this Worker.
setProvider(
	cloudflareBindingProvider({
		binding: env.AI,
		gateway: { id: env.AI_GATEWAY_ID, metadata: { app: 'turbodiff' } },
	}),
);

// Accumulate per-turn token usage and cost onto review rows in D1.
registerReviewMetering();

const startedAt = Date.now();

const app = new Hono();
const reviewer = createAgentRouter(PrReviewer);

app.get('/healthz', async (c) => {
	try {
		await env.DB.prepare('SELECT 1').run();
	} catch (err) {
		console.error('turbodiff: healthz D1 check failed', err);
		return c.json({ ok: false, db: false }, 503);
	}
	return c.json({ ok: true, db: true, uptime_s: Math.round((Date.now() - startedAt) / 1000) });
});

// Reports the live Worker version (Cloudflare Version Metadata binding) so
// deploy tooling can confirm which build is running. No auth, like /healthz.
app.get('/version', (c) => {
	return c.json({ id: env.CF_VERSION_METADATA.id, tag: env.CF_VERSION_METADATA.tag });
});

// Verification evidence (Phase 4): screenshots from verify runs, stored in R2
// and embedded in PR comments — public so GitHub can render them inline. Keys
// are harness-generated (verify/<featureId>/<name>.png), never user input.
app.get('/artifacts/*', async (c) => {
	const key = c.req.path.replace(/^\/artifacts\//, '');
	if (!key || key.includes('..')) return c.notFound();
	// Capability URL: the signature over the key (issued when the artifact was
	// uploaded) is the only credential — no signature, no object, and keys
	// cannot be enumerated.
	const sig = c.req.query('sig') ?? '';
	if (!(await verifyArtifactSig(key, sig))) return c.notFound();
	const object = await env.ARTIFACTS.get(key);
	if (!object) return c.notFound();
	return new Response(object.body, {
		headers: {
			'content-type': object.httpMetadata?.contentType ?? 'application/octet-stream',
			'cache-control': 'public, max-age=31536000, immutable',
		},
	});
});

// Dispatches one configured agent against one PR and records the review row.
// The message is a signal carrying the config snapshot: attributes feed the
// render (model, agent name), the body carries the request plus the agent's
// focus instructions. Returns false when admission fails.
export async function dispatchReviewAgent(
	agent: AgentRow,
	repo: RepositoryRow,
	prNumber: number,
	prUrl: string,
	trigger: string,
	// Auto-dispatch passes the PR's computed risk tier (recorded for the
	// dashboard) and, for trivial PRs, an optional cheap-model override.
	// Mention/manual dispatches omit both.
	opts: { riskTier?: string; modelOverride?: string } = {},
): Promise<boolean> {
	const instanceId = `${agent.slug}--${repo.owner}--${repo.name}--${prNumber}`.toLowerCase();
	// Snapshot the agent's external MCP connections (non-secret fields only;
	// tokens are resolved from D1 at request time by the agent's auth resolver).
	const connections = (await listAgentConnections(agent.id)).map(connectionSnapshot);
	try {
		await dispatch(PrReviewer, {
			id: instanceId,
			message: {
				kind: 'signal',
				type: 'review.request',
				tagName: 'review-request',
				attributes: {
					agent_slug: agent.slug,
					agent_name: agent.name,
					model: opts.modelOverride ?? agent.model,
					pull_request: `${repo.owner}/${repo.name}#${prNumber}`,
					trigger,
					...(connections.length > 0 ? { connections: JSON.stringify(connections) } : {}),
				},
				body:
					`Review pull request #${prNumber} in ${repo.owner}/${repo.name} (${prUrl}) and post your review to GitHub.\n\n` +
					`Agent focus — ${agent.name}:\n${agent.instructions}`,
			},
		});
	} catch (err) {
		console.error(
			`turbodiff: dispatch failed for ${instanceId} (${agent.slug} on ${repo.owner}/${repo.name}#${prNumber}):`,
			err,
		);
		return false;
	}
	await recordReview(
		repo.id,
		repo.installation_id,
		prNumber,
		trigger,
		agent.slug,
		instanceId,
		opts.riskTier ?? null,
	);
	return true;
}

// GitHub App webhooks — authenticated by HMAC signature, not the bearer secret.
app.route('/webhooks', createWebhookRoutes(dispatchReviewAgent));

// SPA data plane (session cookie auth, JSON in/out).
app.route('/api', createApiRoutes());

// SPA shell + landing + OAuth sign-in (session cookie auth).
app.route('/', createUiRoutes());

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
app.use('/internal/*', requireSecret);

app.route('/internal/pr-reviewer', reviewer);

// Software-factory fix loop, Phase 1 spike (docs/software-factory-design.md):
//   POST /internal/fix { "pr_url": "...", "findings"?: "...", "auth_mode"?: "...", "test_command"?: "..." }
// Clones the PR head branch in a sandbox, runs the fix agent against the
// findings (default: turbodiff's latest blocking review), runs tests, pushes.
// The request stays open for the duration of the run (minutes).
// Sandbox health probe: boots the fixer container and reports toolchain
// versions. No GitHub access, no model spend.
app.get('/internal/fix/smoke', async (c) => {
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
//   POST /internal/generate { "repo": "<owner>/<name>", "title": "...", "spec": "..." }
// Records the feature and enqueues the generation run; the generated PR then
// flows through the normal review + auto-fix loop. Poll the status route below.
app.post('/internal/generate', async (c) => {
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
	await env.FACTORY_QUEUE.send({ kind: 'generate', featureId });
	return c.json({ accepted: true, feature_id: featureId, status_url: `/internal/features/${featureId}` });
});

// Software-factory planning intake, Phase 3 (docs/software-factory-design.md).
// The full front half: requirements → clarifying questions → plan + acceptance
// criteria → approve → generation.
//   POST /internal/plans { "repo": "<owner>/<name>", "title": "...", "requirements": "..." }
// Records the plan and enqueues analysis; poll the status route for questions.
app.post('/internal/plans', async (c) => {
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
	await env.FACTORY_QUEUE.send({ kind: 'plan_analyze', planId });
	return c.json({ accepted: true, plan_id: planId, status_url: `/internal/plans/${planId}` });
});

app.get('/internal/plans/:id', async (c) => {
	const id = Number(c.req.param('id'));
	const plan = Number.isInteger(id) ? await getPlan(id) : null;
	if (!plan) return c.json({ error: 'unknown plan' }, 404);
	return c.json(plan);
});

// Submit answers to the clarifying questions; enqueues plan refinement.
app.post('/internal/plans/:id/answers', async (c) => {
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
	await updatePlan(id, { status: 'refining', answers: JSON.stringify(payload.answers.map(String)) });
	await env.FACTORY_QUEUE.send({ kind: 'plan_refine', planId: id });
	return c.json({ accepted: true, plan_id: id, status_url: `/internal/plans/${id}` });
});

// Approve a ready plan: converts it to a generation feature (spec = plan +
// acceptance criteria) and enqueues generation.
app.post('/internal/plans/:id/approve', async (c) => {
	const id = Number(c.req.param('id'));
	const featureIds = await approvePlan(id);
	if (featureIds === null) {
		return c.json({ error: 'plan not found or not in plan_ready state' }, 409);
	}
	await Promise.all(featureIds.map((featureId) => env.FACTORY_QUEUE.send({ kind: 'generate', featureId })));
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
app.post('/internal/repos/run-command', async (c) => {
	const payload = await c.req
		.json<{ repo?: string; command?: string; port?: number }>()
		.catch(() => null);
	const match = payload?.repo?.match(/^([\w.-]+)\/([\w.-]+)$/);
	if (!match || typeof payload?.command !== 'string') {
		return c.json(
			{ error: 'body must be {"repo": "<owner>/<name>", "command": "...", "port": 3000}' },
			400,
		);
	}
	const port = Number.isInteger(payload.port) ? (payload.port as number) : null;
	if (payload.command.trim() && !port) {
		return c.json({ error: 'port is required when command is set' }, 400);
	}
	const repo = await getRepoByFullName(match[1], match[2]);
	if (!repo) return c.json({ error: `Turbodiff is not installed on ${payload.repo}` }, 404);
	await setRepoRunCommand(repo.id, payload.command, port);
	return c.json({ ok: true, repo: payload.repo, run_command: payload.command.trim() || null, app_port: port });
});

app.post('/internal/repos/check-command', async (c) => {
	const payload = await c.req.json<{ repo?: string; command?: string }>().catch(() => null);
	const match = payload?.repo?.match(/^([\w.-]+)\/([\w.-]+)$/);
	if (!match || typeof payload?.command !== 'string') {
		return c.json({ error: 'body must be {"repo": "<owner>/<name>", "command": "..."}' }, 400);
	}
	const repo = await getRepoByFullName(match[1], match[2]);
	if (!repo) return c.json({ error: `Turbodiff is not installed on ${payload.repo}` }, 404);
	await setRepoCheckCommand(repo.id, payload.command);
	return c.json({ ok: true, repo: payload.repo, check_command: payload.command.trim() || null });
});

app.get('/internal/features/:id', async (c) => {
	await failStrandedGeneration();
	const id = Number(c.req.param('id'));
	const feature = Number.isInteger(id) ? await getFeature(id) : null;
	if (!feature) return c.json({ error: 'unknown feature' }, 404);
	return c.json(feature);
});

// Operator retry for a failed generation: re-enqueues the SAME feature row,
// preserving its spec and commit attribution (unlike /internal/generate,
// which would mint a fresh unattributed feature). An optional
// {"delay_seconds": n} defers delivery (e.g. to ride out a platform
// incident); the feature stays in its failed state until the run actually
// starts, so the strand sweep can't misfire during the wait.
app.post('/internal/features/:id/retry', async (c) => {
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
		await env.FACTORY_QUEUE.send({ kind: 'generate', featureId: id }, { delaySeconds: delay });
	} else {
		await updateFeature(id, { error: 'retry queued' });
		await env.FACTORY_QUEUE.send({ kind: 'generate', featureId: id });
	}
	return c.json({
		accepted: true,
		feature_id: id,
		delay_seconds: delay,
		status_url: `/internal/features/${id}`,
	});
});

app.post('/internal/fix', async (c) => {
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
	try {
		const outcome = await runFix({
			owner: repo.owner,
			repo: repo.name,
			prNumber: Number(number),
			installationId: repo.installation_id,
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

export default app;
