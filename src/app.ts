import { setProvider } from '@flue/runtime';
import { cloudflareBindingProvider } from '@flue/runtime/cloudflare/workers-ai';
import { createAgentRouter } from '@flue/runtime/routing';
import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { PrReviewer } from './agents/pr-reviewer.ts';

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

app.get('/healthz', (c) => c.json({ ok: true }));

// Everything else requires the shared secret (Authorization: Bearer <REVIEW_SECRET>).
app.use('*', async (c, next) => {
	const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
	if (!env.REVIEW_SECRET || token !== env.REVIEW_SECRET) {
		return c.json({ error: 'unauthorized' }, 401);
	}
	await next();
});

const reviewer = createAgentRouter(PrReviewer);
app.route('/agents/pr-reviewer', reviewer);

// Convenience endpoint for CI callers:
//   POST /review { "pr_url": "https://github.com/<owner>/<repo>/pull/<number>" }
// Parses the URL, derives a stable per-PR agent id, and dispatches the review.
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
	const agentId = `${owner}--${repo}--${number}`.toLowerCase();

	const res = await reviewer.request(
		`/${agentId}`,
		{
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				kind: 'user',
				body: `Review pull request #${number} in ${owner}/${repo} (${payload!.pr_url}) and post your review to GitHub.`,
			}),
		},
		c.env,
	);
	if (!res.ok) {
		return c.json({ error: 'dispatch failed', status: res.status, detail: await res.text() }, 502);
	}
	return c.json({ accepted: true, agent: `/agents/pr-reviewer/${agentId}`, pr: payload!.pr_url });
});

export default app;
