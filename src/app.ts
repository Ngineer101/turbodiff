import { setProvider } from '@flue/runtime';
import { cloudflareBindingProvider } from '@flue/runtime/cloudflare/workers-ai';
import { createAgentRouter } from '@flue/runtime/routing';
import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { PrReviewer } from './agents/pr-reviewer.ts';
import { getRepoByFullName, recordReview } from './lib/db.ts';
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

const app = new Hono();
const reviewer = createAgentRouter(PrReviewer);

app.get('/healthz', (c) => c.json({ ok: true }));

// Sends the review request into the per-PR agent instance. Used by both the
// webhook auto-trigger and the manual /review endpoint.
async function dispatchReview(
	owner: string,
	repo: string,
	number: number,
	prUrl: string,
): Promise<boolean> {
	const agentId = `${owner}--${repo}--${number}`.toLowerCase();
	const res = await reviewer.request(
		`/${agentId}`,
		{
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				kind: 'user',
				body: `Review pull request #${number} in ${owner}/${repo} (${prUrl}) and post your review to GitHub.`,
			}),
		},
		env,
	);
	return res.ok;
}

// GitHub App webhooks — authenticated by HMAC signature, not the bearer secret.
app.route('/webhooks', createWebhookRoutes(dispatchReview));

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
app.use('/agents/*', requireSecret);
app.use('/review', requireSecret);

app.route('/agents/pr-reviewer', reviewer);

// Manual trigger (e.g. re-review after pushes, or CI callers):
//   POST /review { "pr_url": "https://github.com/<owner>/<repo>/pull/<number>" }
// The repo must have the GitHub App installed — tokens are minted per
// installation, so unknown repos can't be reviewed.
app.post('/review', async (c) => {
	const payload = await c.req.json<{ pr_url?: string }>().catch(() => null);
	const match = payload?.pr_url?.match(
		/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/,
	);
	if (!match) {
		return c.json(
			{ error: 'body must be {"pr_url": "https://github.com/<owner>/<repo>/pull/<n>"}' },
			400,
		);
	}
	const [, owner, repo, number] = match;

	const row = await getRepoByFullName(owner, repo);
	if (!row) {
		return c.json({ error: `Turbodiff is not installed on ${owner}/${repo}` }, 404);
	}

	const ok = await dispatchReview(owner, repo, Number(number), payload!.pr_url!);
	if (!ok) return c.json({ error: 'dispatch failed' }, 502);

	await recordReview(row.id, row.installation_id, Number(number), 'manual');
	const agentId = `${owner}--${repo}--${number}`.toLowerCase();
	return c.json({ accepted: true, agent: `/agents/pr-reviewer/${agentId}`, pr: payload!.pr_url });
});

export default app;
