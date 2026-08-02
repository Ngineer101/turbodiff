import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import {
	addRepositories,
	deleteInstallation,
	getInstallation,
	getRepoById,
	recordReview,
	removeRepositories,
	reviewCountLastDay,
	setInstallationSuspended,
	upsertInstallation,
} from '../lib/db.ts';
import { verifyWebhookSignature } from '../lib/github-app.ts';

// GitHub App webhook receiver. Two jobs:
//   1. Mirror installation / repository-selection changes into D1.
//   2. Auto-dispatch a review when a PR opens or leaves draft on an enabled repo.

interface WebhookAccount {
	login: string;
	id: number;
	type: string;
}

interface WebhookRepoRef {
	id: number;
	name: string;
	full_name: string;
}

interface InstallationEvent {
	action: string;
	installation: { id: number; account: WebhookAccount };
	repositories?: WebhookRepoRef[];
	repositories_added?: WebhookRepoRef[];
	repositories_removed?: WebhookRepoRef[];
}

interface PullRequestEvent {
	action: string;
	number: number;
	pull_request: { draft: boolean; html_url: string };
	repository: { id: number; full_name: string };
}

interface HandlerResult {
	body: Record<string, unknown>;
	status?: 401 | 502;
}

export type ReviewDispatcher = (
	owner: string,
	repo: string,
	number: number,
	prUrl: string,
) => Promise<boolean>;

// A Hono sub-app; the caller supplies dispatch so this module doesn't need to
// know about the agent router.
export function createWebhookRoutes(dispatch: ReviewDispatcher) {
	const app = new Hono();

	app.post('/github', async (c) => {
		const rawBody = await c.req.arrayBuffer();
		const ok = await verifyWebhookSignature(rawBody, c.req.header('x-hub-signature-256'));
		if (!ok) return c.json({ error: 'invalid signature' }, 401);

		const event = c.req.header('x-github-event') ?? '';
		const payload = JSON.parse(new TextDecoder().decode(rawBody));
		const result = await handleEvent(event, payload, dispatch);
		return c.json(result.body, result.status ?? 200);
	});

	return app;
}

async function handleEvent(
	event: string,
	payload: unknown,
	dispatch: ReviewDispatcher,
): Promise<HandlerResult> {
	switch (event) {
		case 'installation':
			return handleInstallation(payload as InstallationEvent);
		case 'installation_repositories':
			return handleInstallationRepositories(payload as InstallationEvent);
		case 'pull_request':
			return handlePullRequest(payload as PullRequestEvent, dispatch);
		case 'repository': {
			// Keep owner/name current when a repo is renamed or transferred.
			const p = payload as { action: string; repository: WebhookRepoRef };
			if (p.action === 'renamed' || p.action === 'transferred') {
				const row = await getRepoById(p.repository.id);
				if (row) await addRepositories(row.installation_id, [p.repository]);
				return { body: { ok: true, updated: p.repository.full_name } };
			}
			return { body: { ok: true, ignored: p.action } };
		}
		default:
			return { body: { ok: true, ignored: event } };
	}
}

async function handleInstallation(p: InstallationEvent): Promise<HandlerResult> {
	switch (p.action) {
		case 'created':
			await upsertInstallation(p.installation.id, p.installation.account);
			await addRepositories(p.installation.id, p.repositories ?? []);
			return { body: { ok: true, installed: p.installation.account.login } };
		case 'deleted':
			await deleteInstallation(p.installation.id);
			return { body: { ok: true, uninstalled: p.installation.account.login } };
		case 'suspend':
		case 'unsuspend':
			await setInstallationSuspended(p.installation.id, p.action === 'suspend');
			return { body: { ok: true, [p.action]: p.installation.account.login } };
		default:
			return { body: { ok: true, ignored: p.action } };
	}
}

async function handleInstallationRepositories(p: InstallationEvent): Promise<HandlerResult> {
	// Repo selection changed in GitHub's UI — make sure the installation row
	// exists (e.g. if the original `installation created` delivery was missed).
	await upsertInstallation(p.installation.id, p.installation.account);
	await addRepositories(p.installation.id, p.repositories_added ?? []);
	await removeRepositories((p.repositories_removed ?? []).map((r) => r.id));
	return {
		body: {
			ok: true,
			added: (p.repositories_added ?? []).length,
			removed: (p.repositories_removed ?? []).length,
		},
	};
}

async function handlePullRequest(
	p: PullRequestEvent,
	dispatch: ReviewDispatcher,
): Promise<HandlerResult> {
	if (p.action !== 'opened' && p.action !== 'ready_for_review') {
		return { body: { ok: true, ignored: p.action } };
	}
	if (p.pull_request.draft) return { body: { ok: true, skipped: 'draft' } };

	const repo = await getRepoById(p.repository.id);
	if (!repo) return { body: { ok: true, skipped: 'repo not tracked' } };
	if (!repo.enabled) return { body: { ok: true, skipped: 'reviews disabled for repo' } };

	const installation = await getInstallation(repo.installation_id);
	if (!installation || installation.suspended) {
		return { body: { ok: true, skipped: 'installation missing or suspended' } };
	}

	const limit = Number(env.REVIEW_DAILY_LIMIT) || 50;
	const used = await reviewCountLastDay(repo.installation_id);
	if (used >= limit) {
		console.warn(
			`turbodiff: daily review cap (${limit}) reached for installation ${repo.installation_id} (${installation.account_login}); skipping ${p.repository.full_name}#${p.number}`,
		);
		return { body: { ok: true, skipped: 'daily review limit reached' } };
	}

	const dispatched = await dispatch(repo.owner, repo.name, p.number, p.pull_request.html_url);
	if (!dispatched) return { body: { error: 'dispatch failed' }, status: 502 };

	await recordReview(repo.id, repo.installation_id, p.number, p.action);
	return { body: { ok: true, review: `${p.repository.full_name}#${p.number}` } };
}
