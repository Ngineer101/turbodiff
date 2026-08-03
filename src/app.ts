import { dispatch, setProvider } from '@flue/runtime';
import { cloudflareBindingProvider } from '@flue/runtime/cloudflare/workers-ai';
import { createAgentRouter } from '@flue/runtime/routing';
import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { PrReviewer } from './agents/pr-reviewer.ts';
import {
	connectionSnapshot,
	getAgentBySlug,
	getRepoByFullName,
	listAgentConnections,
	listAgentsForRepo,
	recordReview,
	type AgentRow,
	type RepositoryRow,
} from './lib/db.ts';
import { registerReviewMetering } from './lib/metering.ts';
import { createSettingsRoutes } from './routes/settings.ts';
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

const app = new Hono();
const reviewer = createAgentRouter(PrReviewer);

app.get('/healthz', (c) => c.json({ ok: true }));

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
					model: agent.model,
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
	await recordReview(repo.id, repo.installation_id, prNumber, trigger, agent.slug, instanceId);
	return true;
}

// GitHub App webhooks — authenticated by HMAC signature, not the bearer secret.
app.route('/webhooks', createWebhookRoutes(dispatchReviewAgent));

// Settings UI + OAuth sign-in (session cookie auth).
app.route('/', createSettingsRoutes());

// Operator endpoints keep the shared secret (Authorization: Bearer <REVIEW_SECRET>).
const requireSecret = createMiddleware(async (c, next) => {
	const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
	if (!env.REVIEW_SECRET || token !== env.REVIEW_SECRET) {
		return c.json({ error: 'unauthorized' }, 401);
	}
	await next();
});
// The agent conversation surface (debugging: GET /internal/pr-reviewer/<instance-id>
// returns the durable conversation incl. settlements). Lives under /internal
// because the signed-in UI owns /agents.
app.use('/internal/*', requireSecret);
app.use('/review', requireSecret);

app.route('/internal/pr-reviewer', reviewer);

// Manual trigger (e.g. re-review after pushes, or CI callers):
//   POST /review { "pr_url": "https://github.com/<owner>/<repo>/pull/<n>", "agent"?: "<slug>" }
// Without "agent", every agent enabled for the repo runs; with it, exactly
// that agent (enabled or not — an explicit call is explicit intent). The repo
// must have the GitHub App installed — tokens are minted per installation.
app.post('/review', async (c) => {
	const payload = await c.req.json<{ pr_url?: string; agent?: string }>().catch(() => null);
	const match = payload?.pr_url?.match(
		/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/,
	);
	if (!match) {
		return c.json(
			{ error: 'body must be {"pr_url": "https://github.com/<owner>/<repo>/pull/<n>", "agent"?: "<slug>"}' },
			400,
		);
	}
	const [, owner, repoName, number] = match;
	const prNumber = Number(number);

	const repo = await getRepoByFullName(owner, repoName);
	if (!repo) {
		return c.json({ error: `Turbodiff is not installed on ${owner}/${repoName}` }, 404);
	}

	let agents: AgentRow[];
	if (payload?.agent) {
		const agent = await getAgentBySlug(repo.installation_id, payload.agent);
		if (!agent) return c.json({ error: `no agent "${payload.agent}" in this installation` }, 404);
		agents = [agent];
	} else {
		agents = (await listAgentsForRepo(repo)).filter((a) => a.enabled);
		if (agents.length === 0) return c.json({ error: 'no agents enabled for this repository' }, 409);
	}

	const dispatched: string[] = [];
	for (const agent of agents) {
		if (await dispatchReviewAgent(agent, repo, prNumber, payload!.pr_url!, 'manual')) {
			dispatched.push(agent.slug);
		}
	}
	if (dispatched.length === 0) return c.json({ error: 'dispatch failed' }, 502);
	return c.json({ accepted: true, agents: dispatched, pr: payload!.pr_url });
});

export default app;
