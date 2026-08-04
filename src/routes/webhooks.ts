import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import {
	addRepositories,
	deleteInstallation,
	ensureBuiltinAgents,
	getAgentBySlug,
	getInstallation,
	getRepoById,
	hasActiveReview,
	listAgentsForRepo,
	removeRepositories,
	reviewCountLastDay,
	reviewedRecently,
	setInstallationSuspended,
	upsertInstallation,
	type AgentRow,
	type RepositoryRow,
} from '../lib/db.ts';
import { reactToIssueComment, verifyWebhookSignature } from '../lib/github-app.ts';
import { agentsForTier, computeRiskTier, tierModelOverride, type RiskTier } from '../lib/risk.ts';

// GitHub App webhook receiver. Three jobs:
//   1. Mirror installation / repository-selection changes into D1.
//   2. Auto-dispatch every repo-enabled agent when a PR opens or leaves draft.
//   3. Dispatch on-demand reviews when a collaborator comments
//      "@<app-slug> review", "@<app-slug> <agent-slug>", or "@<app-slug> all"
//      on a PR (requires the App to subscribe to the Issue comment event and
//      hold Issues read & write — write for the 👀 acknowledgement reaction).

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

interface IssueCommentEvent {
	action: string;
	issue: {
		number: number;
		state: string;
		// Present only when the "issue" is actually a pull request.
		pull_request?: { html_url: string };
	};
	comment: {
		id: number;
		body: string;
		// OWNER | MEMBER | COLLABORATOR | CONTRIBUTOR | NONE | ...
		author_association: string;
		user: { login: string; type: string };
	};
	repository: { id: number; full_name: string };
}

interface HandlerResult {
	body: Record<string, unknown>;
	status?: 401 | 502;
}

export type ReviewDispatcher = (
	agent: AgentRow,
	repo: RepositoryRow,
	prNumber: number,
	prUrl: string,
	trigger: string,
	opts?: { riskTier?: string; modelOverride?: string },
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
		case 'issue_comment':
			return handleIssueComment(payload as IssueCommentEvent, dispatch);
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
			await ensureBuiltinAgents(p.installation.id);
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

// A push burst re-dispatches an agent at most once per window.
const PUSH_DEBOUNCE_MINUTES = 10;

async function handlePullRequest(
	p: PullRequestEvent,
	dispatch: ReviewDispatcher,
): Promise<HandlerResult> {
	if (p.action !== 'opened' && p.action !== 'ready_for_review' && p.action !== 'synchronize') {
		return { body: { ok: true, ignored: p.action } };
	}
	if (p.pull_request.draft) return { body: { ok: true, skipped: 'draft' } };

	const repo = await getRepoById(p.repository.id);
	if (!repo) return { body: { ok: true, skipped: 'repo not tracked' } };
	if (!repo.enabled) return { body: { ok: true, skipped: 'reviews disabled for repo' } };
	if (p.action === 'synchronize' && !repo.review_on_push) {
		return { body: { ok: true, skipped: 'push reviews disabled for repo' } };
	}

	const installation = await getInstallation(repo.installation_id);
	if (!installation || installation.suspended) {
		return { body: { ok: true, skipped: 'installation missing or suspended' } };
	}

	const enabled = (await listAgentsForRepo(repo)).filter((a) => a.enabled);
	if (enabled.length === 0) return { body: { ok: true, skipped: 'no agents enabled' } };

	// Classify the PR before spending budget: small mechanical changes get one
	// generalist, only large or security-sensitive ones the full fleet. Fail
	// open to 'full' — a tiering hiccup must widen review, never skip it.
	let tier: RiskTier = 'full';
	try {
		tier = await computeRiskTier(repo.installation_id, repo.owner, repo.name, p.number);
	} catch (err) {
		console.warn(
			`turbodiff: risk tier computation failed for ${p.repository.full_name}#${p.number}, defaulting to full:`,
			err,
		);
	}
	let agents = agentsForTier(tier, enabled);
	const modelOverride = tierModelOverride(tier);

	// Pushes re-review with awareness (the agent reconciles against existing
	// threads), but debounced: skip agents mid-review or dispatched within the
	// window, so a burst of pushes costs one re-review, not one per push.
	if (p.action === 'synchronize') {
		const idle: typeof agents = [];
		for (const agent of agents) {
			const busy =
				(await hasActiveReview(repo.id, p.number, agent.slug)) ||
				(await reviewedRecently(repo.id, p.number, agent.slug, PUSH_DEBOUNCE_MINUTES));
			if (!busy) idle.push(agent);
		}
		agents = idle;
		if (agents.length === 0) {
			return { body: { ok: true, skipped: 'all agents busy or within push debounce' } };
		}
	}

	// The daily cap counts agent-runs, so N selected agents consume N units.
	const budget = await remainingDailyBudget(repo.installation_id, installation.account_login);
	if (budget <= 0) return { body: { ok: true, skipped: 'daily review limit reached' } };
	if (agents.length > budget) {
		console.warn(
			`turbodiff: daily cap leaves budget for ${budget} of ${agents.length} agents on ${p.repository.full_name}#${p.number}`,
		);
	}

	const dispatched: string[] = [];
	for (const agent of agents.slice(0, budget)) {
		const opts = { riskTier: tier, ...(modelOverride ? { modelOverride } : {}) };
		if (await dispatch(agent, repo, p.number, p.pull_request.html_url, p.action, opts)) {
			dispatched.push(agent.slug);
		}
	}
	if (dispatched.length === 0) return { body: { error: 'dispatch failed' }, status: 502 };
	return {
		body: { ok: true, review: `${p.repository.full_name}#${p.number}`, tier, agents: dispatched },
	};
}

// Agent-runs left under the installation's daily cap.
async function remainingDailyBudget(installationId: number, accountLogin: string): Promise<number> {
	const limit = Number(env.REVIEW_DAILY_LIMIT) || 50;
	const used = await reviewCountLastDay(installationId);
	const remaining = limit - used;
	if (remaining <= 0) {
		console.warn(
			`turbodiff: daily review cap (${limit}) reached for installation ${installationId} (${accountLogin})`,
		);
	}
	return remaining;
}

// Only these author associations may spend the installation's tokens by
// tagging the app — drive-by commenters on public repos cannot.
const MENTION_ALLOWED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

// "@<app-slug> <command>" — command is an agent slug, "review" (the default
// agent), or "all" (every repo-enabled agent).
function parseMentionCommand(body: string): string | null {
	const slug = (env.GITHUB_APP_SLUG || 'turbodiff').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const match = body.match(new RegExp(`@${slug}\\s+([a-z0-9][a-z0-9_-]*)`, 'i'));
	return match ? match[1].toLowerCase() : null;
}

// A mention in a PR comment dispatches on-demand reviews. Deliberately
// ignores the per-repo auto-review toggles for a named agent (a mention is
// explicit intent — toggles only gate automatic dispatch) and allows drafts.
async function handleIssueComment(
	p: IssueCommentEvent,
	dispatch: ReviewDispatcher,
): Promise<HandlerResult> {
	// Only fresh comments; edits and deletions never (re-)trigger.
	if (p.action !== 'created') return { body: { ok: true, ignored: p.action } };
	if (!p.issue.pull_request) return { body: { ok: true, ignored: 'not a PR comment' } };
	// Never react to bots — including our own review posts (loop prevention).
	if (p.comment.user.type === 'Bot') return { body: { ok: true, ignored: 'bot comment' } };
	const command = parseMentionCommand(p.comment.body);
	if (!command) return { body: { ok: true, ignored: 'no review command' } };
	if (!MENTION_ALLOWED_ASSOCIATIONS.has(p.comment.author_association)) {
		return { body: { ok: true, skipped: 'commenter is not a collaborator' } };
	}
	if (p.issue.state !== 'open') return { body: { ok: true, skipped: 'PR is closed' } };

	const repo = await getRepoById(p.repository.id);
	if (!repo) return { body: { ok: true, skipped: 'repo not tracked' } };

	const installation = await getInstallation(repo.installation_id);
	if (!installation || installation.suspended) {
		return { body: { ok: true, skipped: 'installation missing or suspended' } };
	}

	// Resolve the command to agents. An unknown slug gets a 😕 so the
	// commenter learns the tag was seen but matched nothing.
	await ensureBuiltinAgents(repo.installation_id);
	let agents: AgentRow[];
	if (command === 'all') {
		agents = (await listAgentsForRepo(repo)).filter((a) => a.enabled);
		if (agents.length === 0) return { body: { ok: true, skipped: 'no agents enabled' } };
	} else {
		const agent = await getAgentBySlug(repo.installation_id, command);
		if (!agent) {
			await react(repo.installation_id, p.repository.full_name, p.comment.id, 'confused');
			return { body: { ok: true, skipped: `unknown agent "${command}"` } };
		}
		agents = [agent];
	}

	// Skip agents already reviewing this PR (a re-tag can't double-dispatch).
	const idle: AgentRow[] = [];
	for (const agent of agents) {
		if (!(await hasActiveReview(repo.id, p.issue.number, agent.slug))) idle.push(agent);
	}
	if (idle.length === 0) {
		return { body: { ok: true, skipped: 'review already running for this PR' } };
	}

	const budget = await remainingDailyBudget(repo.installation_id, installation.account_login);
	if (budget <= 0) return { body: { ok: true, skipped: 'daily review limit reached' } };

	const dispatched: string[] = [];
	for (const agent of idle.slice(0, budget)) {
		if (await dispatch(agent, repo, p.issue.number, p.issue.pull_request.html_url, 'mention')) {
			dispatched.push(agent.slug);
		}
	}
	if (dispatched.length === 0) return { body: { error: 'dispatch failed' }, status: 502 };

	await react(repo.installation_id, p.repository.full_name, p.comment.id, 'eyes');
	return {
		body: {
			ok: true,
			review: `${p.repository.full_name}#${p.issue.number}`,
			agents: dispatched,
			trigger: 'mention',
		},
	};
}

// Best-effort acknowledgement reaction; failure (e.g. the App lacks
// Issues:write until re-approved) must never fail the webhook.
async function react(
	installationId: number,
	repoFullName: string,
	commentId: number,
	content: 'eyes' | 'confused',
): Promise<void> {
	try {
		await reactToIssueComment(installationId, repoFullName, commentId, content);
	} catch (err) {
		console.warn(`turbodiff: could not react to comment ${commentId}:`, err);
	}
}
