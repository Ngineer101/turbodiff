import { env } from 'cloudflare:workers';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { html, raw } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import {
	agentUsageForMonth,
	connectionSnapshot,
	countReviews,
	createAgent,
	createAgentConnection,
	createPlan,
	getPlan,
	getPlanByFeatureId,
	getFeature,
	latestVerificationForFeature,
	createCockpitComment,
	listCockpitComments,
	markCockpitCommentDispatched,
	listPlansForInstallations,
	updatePlan,
	dashboardStats,
	deleteAgent,
	deleteAgentConnection,
	ensureBuiltinAgents,
	getAgentById,
	getAgentBySlug,
	getAgentConnection,
	getRepoById,
	getRepoByFullName,
	listAgentConnections,
	listAgents,
	listInstallationsWithRepos,
	listRecentReviews,
	listRepoAgentOverrides,
	monthlyUsage,
	repoUsageForMonth,
	resolveAgentEnabled,
	setRepoAgentEnabled,
	setRepoAutoFix,
	setRepoAutoMerge,
	setRepoBlockingReviews,
	setRepoCheckCommand,
	setRepoEnabled,
	setRepoReviewOnPush,
	updateAgent,
	type AgentConnectionRow,
	type AgentRow,
	type PlanRow,
	type PlanWithRepo,
	type ReviewActivityRow,
} from '../lib/db.ts';
import { parsePatchFiles, wrapCoreCSS } from '@pierre/diffs';
import { preloadDiffHTML } from '@pierre/diffs/ssr';
import { approvePlan } from '../lib/planner.ts';
import { signArtifactKey } from '../lib/crypto.ts';
import { gh } from '../tools/github.ts';
import { encryptionConfigured, openToken, sealToken } from '../lib/crypto.ts';
import { testMcpEndpoint } from '../lib/mcp-test.ts';
import { DEFAULT_MODEL, RESERVED_AGENT_SLUGS } from '../lib/personas.ts';
import {
	exchangeOAuthCode,
	fetchUser,
	fetchUserInstallationIds,
	installationToken,
	oauthAuthorizeUrl,
} from '../lib/github-app.ts';
import {
	openSession,
	randomToken,
	sealSession,
	SESSION_COOKIE,
	SESSION_TTL_SECONDS,
	type Session,
} from '../lib/session.ts';
import { renderLanding } from './landing.tsx';

// Signed-in UI: / is the dashboard (metrics first, drill-downs below),
// /reviews is the full review history, /settings holds per-repo config.
// Repo *selection* happens in GitHub's own install flow; these pages only
// hold Turbodiff config and usage data.

const STATE_COOKIE = 'turbodiff_oauth_state';

function page(title: string, body: HtmlEscapedString | Promise<HtmlEscapedString>) {
	return html`<!doctype html>
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<title>${title}</title>
				<link rel="preconnect" href="https://fonts.googleapis.com" />
				<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
				<link
					href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&display=swap"
					rel="stylesheet"
				/>
				<style>
					:root { color-scheme: dark; }
					body {
						font: 14px/1.6 'IBM Plex Mono', ui-monospace, monospace;
						background: #070b09; color: #e6efe9;
						max-width: 860px; margin: 3rem auto; padding: 0 1rem;
					}
					h1 { font-size: 1.25rem; font-weight: 500; letter-spacing: 0.02em; }
					h2 { font-size: 0.95rem; font-weight: 500; margin-top: 2.25rem; color: #b8c4bc; }
					h2::before { content: '// '; color: #3fb950; }
					.list-nav { margin-top: 0.75rem; text-align: right; }
					a { color: #56d364; }
					a.button, button {
						display: inline-block; padding: 0.45rem 1rem; border-radius: 6px;
						border: 1px solid rgba(86, 211, 100, 0.4); background: #3fb950; color: #04140a;
						text-decoration: none; font: inherit; font-weight: 500; font-size: 0.85rem; cursor: pointer;
					}
					a.button:hover, button:hover { background: #56d364; }
					a.button.secondary, button.secondary {
						background: transparent; color: #e6efe9; border-color: #2a3830;
					}
					a.button.secondary:hover, button.secondary:hover { background: #131a16; border-color: #3fb95066; }
					table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; }
					td, th { padding: 0.5rem 0.4rem; border-top: 1px solid #1c2620; }
					th { text-align: left; font-weight: 400; font-size: 0.75rem; color: #7d8f85; border-top: none; padding-bottom: 0.15rem; }
					td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
					.muted { color: #7d8f85; font-size: 0.85rem; }
					.pill { font-size: 0.75rem; padding: 0.1rem 0.55rem; border-radius: 999px; border: 1px solid #2a3830; color: #7d8f85; white-space: nowrap; }
					.pill.red { border-color: #f8514966; color: #f85149; }
					.pill.on { border-color: #3fb95066; color: #56d364; }
					.pill.running { border-color: #3fb95066; color: #56d364; }
					.pill.running::before { content: '● '; animation: pulse 1.6s ease-in-out infinite; }
					@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
					.topbar { display: flex; justify-content: space-between; align-items: center; }
					form { display: inline; }
					nav.tabs { margin: 0.75rem 0 0; display: flex; gap: 1.25rem; border-bottom: 1px solid #1c2620; padding-bottom: 0.6rem; }
					nav.tabs a { color: #7d8f85; text-decoration: none; font-size: 0.85rem; }
					nav.tabs a:hover { color: #e6efe9; }
					nav.tabs a.active { color: #56d364; }
					.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 0.75rem; margin-top: 1.25rem; }
					.tile { border: 1px solid #1c2620; border-radius: 8px; padding: 0.85rem 1rem; background: #0a100d; }
					.tile .label { font-size: 0.72rem; color: #7d8f85; }
					.tile .value { font-size: 1.45rem; font-weight: 600; margin-top: 0.15rem; font-variant-numeric: tabular-nums; }
					.tile .sub { font-size: 0.72rem; color: #7d8f85; margin-top: 0.1rem; }
					.bar-track { display: inline-block; width: 100%; }
					.bar { height: 14px; background: #2ea043; border-radius: 0 4px 4px 0; min-width: 2px; }
					.pager { display: flex; justify-content: space-between; margin-top: 1rem; }
					button.chip {
						padding: 0.1rem 0.55rem; font-size: 0.72rem; border-radius: 999px;
						background: transparent; color: #7d8f85; border: 1px solid #2a3830;
					}
					button.chip:hover { background: #131a16; }
					button.chip.on { color: #56d364; border-color: #3fb95066; }
					.chips { display: flex; flex-wrap: wrap; gap: 0.3rem; margin-top: 0.3rem; }
					label { display: block; margin-top: 1rem; font-size: 0.78rem; color: #7d8f85; }
					input[type='text'], textarea {
						width: 100%; box-sizing: border-box; margin-top: 0.25rem;
						background: #0a100d; border: 1px solid #2a3830; border-radius: 6px;
						color: #e6efe9; font: inherit; padding: 0.45rem 0.6rem;
					}
					textarea { min-height: 10rem; resize: vertical; }
					.form-error { color: #f85149; font-size: 0.85rem; margin-top: 1rem; }
				</style>
			</head>
			<body>${body}</body>
		</html>`;
}

// D1's datetime('now') stores UTC as 'YYYY-MM-DD HH:MM:SS'.
function parseUtc(sql: string): number {
	return Date.parse(`${sql.replace(' ', 'T')}Z`);
}

function ago(sql: string): string {
	const s = Math.max(0, Math.floor((Date.now() - parseUtc(sql)) / 1000));
	if (s < 60) return `${s}s ago`;
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return `${Math.floor(s / 86400)}d ago`;
}

function fmtUsd(n: number): string {
	if (n >= 1) return `$${n.toFixed(2)}`;
	if (n >= 0.01) return `$${n.toFixed(3)}`;
	if (n > 0) return `$${n.toFixed(4)}`;
	return '$0.00';
}

function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 10_000) return `${Math.round(n / 1000)}K`;
	if (n >= 1_000) return `${(n / 1000).toFixed(1)}K`;
	return String(n);
}

function fmtDuration(seconds: number): string {
	const s = Math.max(1, Math.round(seconds));
	if (s < 60) return `${s}s`;
	return `${Math.floor(s / 60)}m ${s % 60}s`;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthLabel(ym: string): string {
	const [y, m] = ym.split('-');
	return `${MONTH_NAMES[Number(m) - 1] ?? m} ${y}`;
}

function currentMonth(): string {
	return new Date().toISOString().slice(0, 7);
}

// A dispatch that never completed and is older than this is presumed dead
// (agent error before post_review) rather than still running.
const STALL_AFTER_MS = 20 * 60 * 1000;

function reviewState(r: ReviewActivityRow): 'running' | 'completed' | 'stalled' | 'failed' {
	if (r.status === 'failed') return 'failed';
	if (r.status !== 'running') return 'completed';
	return Date.now() - parseUtc(r.created_at) > STALL_AFTER_MS ? 'stalled' : 'running';
}

function reviewTotalTokens(r: ReviewActivityRow): number {
	return r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_tokens;
}

function reviewDurationS(r: ReviewActivityRow): number | null {
	if (r.completed_at === null) return null;
	return (parseUtc(r.completed_at) - parseUtc(r.created_at)) / 1000;
}

function statusPill(r: ReviewActivityRow) {
	const state = reviewState(r);
	if (state === 'running') return html`<span class="pill running">reviewing</span>`;
	if (state === 'stalled') return html`<span class="pill red">stalled</span>`;
	if (state === 'failed') return html`<span class="pill red">failed</span>`;
	return r.review_url
		? html`<a href="${r.review_url}"><span class="pill">done &rarr;</span></a>`
		: html`<span class="pill">done</span>`;
}

// One row of the reviews table: PR · status · tokens · cost · duration · age.
// Zero-usage rows (predating metering, or not yet metered) render as "—".
function reviewRow(r: ReviewActivityRow) {
	const repoFull =
		r.repo_owner && r.repo_name ? `${r.repo_owner}/${r.repo_name}` : '(removed repository)';
	const prUrl =
		r.repo_owner && r.repo_name
			? `https://github.com/${r.repo_owner}/${r.repo_name}/pull/${r.pr_number}`
			: null;
	const tokens = reviewTotalTokens(r);
	const duration = reviewDurationS(r);
	return html`<tr>
		<td>
			${prUrl ? html`<a href="${prUrl}">${repoFull}#${r.pr_number}</a>` : html`${repoFull}#${r.pr_number}`}
			<span class="muted"
				>&middot; ${r.agent_slug ?? 'review'} &middot; ${r.trigger_event}${r.risk_tier
					? html` &middot; ${r.risk_tier}`
					: ''}${r.findings_count !== null
					? html` &middot; ${r.findings_count} finding${r.findings_count === 1 ? '' : 's'}`
					: ''}</span
			>
		</td>
		<td>${statusPill(r)}</td>
		<td class="num">${tokens > 0 ? fmtTokens(tokens) : html`<span class="muted">—</span>`}</td>
		<td class="num">${r.cost_usd > 0 ? fmtUsd(r.cost_usd) : html`<span class="muted">—</span>`}</td>
		<td class="num">${duration !== null ? fmtDuration(duration) : html`<span class="muted">—</span>`}</td>
		<td class="num muted">${ago(r.created_at)}</td>
	</tr>`;
}

const reviewsHead = html`<tr>
	<th>pull request</th>
	<th>status</th>
	<th class="num">tokens</th>
	<th class="num">cost</th>
	<th class="num">time</th>
	<th class="num">when</th>
</tr>`;

function topbar(login: string) {
	return html`<div class="topbar">
		<h1>Turbodiff</h1>
		<div>
			<span class="muted">@${login}</span>
			<form method="post" action="/auth/logout"><button class="secondary">Sign out</button></form>
		</div>
	</div>`;
}

function tabs(active: 'dashboard' | 'factory' | 'reviews' | 'agents' | 'settings') {
	return html`<nav class="tabs">
		<a href="/" class="${active === 'dashboard' ? 'active' : ''}">dashboard</a>
		<a href="/factory" class="${active === 'factory' ? 'active' : ''}">factory</a>
		<a href="/reviews" class="${active === 'reviews' ? 'active' : ''}">reviews</a>
		<a href="/agents" class="${active === 'agents' ? 'active' : ''}">agents</a>
		<a href="/settings" class="${active === 'settings' ? 'active' : ''}">settings</a>
	</nav>`;
}

const PLAN_STATUS_HINT: Record<string, string> = {
	analyzing: 'analyzing the repo and drafting clarifying questions…',
	awaiting_answers: 'answer the questions below to continue',
	refining: 'incorporating your answers into the plan…',
	plan_ready: 'review the plan and approve to generate',
	approved: 'generating — follow the pull request',
	failed: 'failed — see the error',
};

const RUNNING_PLAN_STATUSES = new Set(['analyzing', 'refining']);

// Latest verification for an approved plan's feature, as a compact pill:
// passed (n/n) / failed (n unmet) / running / error. Full evidence lives in
// the PR's report comment.
// Inline pill for the cockpit header, from raw status + results.
function renderVerificationInline(
	status: string | null,
	results: { verdict: string }[],
): HtmlEscapedString | Promise<HtmlEscapedString> | '' {
	if (!status) return '';
	const failed = results.filter((r) => r.verdict === 'fail').length;
	const detail =
		status === 'passed'
			? ` (${results.length}/${results.length})`
			: status === 'failed'
				? ` (${failed} unmet)`
				: '';
	const cls = status === 'passed' ? 'on' : status === 'running' ? 'running' : 'red';
	return html` · <span class="pill ${cls}">verify: ${status}${detail}</span>`;
}

function renderVerification(p: PlanWithRepo): HtmlEscapedString | Promise<HtmlEscapedString> | '' {
	if (!p.verification_status) return '';
	let detail = '';
	try {
		const results = JSON.parse(p.verification_results ?? '[]') as { verdict: string }[];
		const failed = results.filter((r) => r.verdict === 'fail').length;
		if (p.verification_status === 'passed') detail = ` (${results.length}/${results.length})`;
		else if (p.verification_status === 'failed') detail = ` (${failed} unmet)`;
	} catch {
		// results unparsable — show the bare status
	}
	const cls =
		p.verification_status === 'passed'
			? 'on'
			: p.verification_status === 'running'
				? 'running'
				: 'red';
	return html` <span class="pill ${cls}">verify: ${p.verification_status}${detail}</span>`;
}

// One plan card: status, plus the interactive surface for its current state
// (answer form when awaiting answers, plan + approve when ready, PR link once
// generating).
function renderPlan(p: PlanWithRepo): HtmlEscapedString | Promise<HtmlEscapedString> {
	const questions: string[] = p.questions ? JSON.parse(p.questions) : [];
	const acceptance: string[] = p.acceptance ? JSON.parse(p.acceptance) : [];
	const running = RUNNING_PLAN_STATUSES.has(p.status);
	return html`<div class="tile" style="margin-top:0.75rem">
		<div class="topbar">
			<strong>${p.title}</strong>
			<span class="pill ${running ? 'running' : p.status === 'failed' ? 'red' : 'on'}">${p.status}</span>
		</div>
		<div class="muted" style="margin:0.15rem 0 0.5rem">
			${p.owner}/${p.name} · ${PLAN_STATUS_HINT[p.status] ?? ''} · ${ago(p.created_at)}
		</div>
		${p.status === 'failed' && p.error ? html`<p class="form-error">${p.error}</p>` : ''}
		${p.status === 'awaiting_answers' && questions.length > 0
			? html`<form method="post" action="/factory/plans/${p.id}/answers">
					${questions.map(
						(q, i) => html`<label
							>${q}
							<input type="text" name="answer_${i}" placeholder="your answer" />
						</label>`,
					)}
					<p style="margin-top:0.6rem"><button type="submit">Submit answers</button></p>
				</form>`
			: ''}
		${p.status === 'plan_ready'
			? html`<details open>
						<summary class="muted">implementation plan</summary>
						<pre style="white-space:pre-wrap;margin-top:0.4rem">${p.plan ?? ''}</pre>
						${acceptance.length > 0
							? html`<div class="muted" style="margin-top:0.4rem">acceptance criteria</div>
									<ul>
										${acceptance.map((a) => html`<li>${a}</li>`)}
									</ul>`
							: ''}
					</details>
					<form method="post" action="/factory/plans/${p.id}/approve">
						<p style="margin-top:0.6rem"><button type="submit">Approve &amp; generate</button></p>
					</form>`
			: ''}
		${p.status === 'approved' && p.pr_number
			? html`<p style="margin-top:0.4rem">
					<a href="/factory/features/${p.feature_id}"><strong>open in cockpit &rarr;</strong></a>
					· <a href="https://github.com/${p.owner}/${p.name}/pull/${p.pr_number}"
						>PR #${p.pr_number}</a
					>
					${renderVerification(p)}
				</p>`
			: ''}
	</div>`;
}

type AuthedUser = { session: Session; installationIds: number[] };

// Load the plan named by the :id param only if the caller may manage the repo
// it belongs to (its installation is in the user's set). Null otherwise.
async function authorizedPlan(c: Context, user: AuthedUser): Promise<PlanRow | null> {
	const id = Number(c.req.param('id'));
	const plan = Number.isInteger(id) ? await getPlan(id) : null;
	if (!plan) return null;
	const repo = await getRepoById(plan.repository_id);
	if (!repo || !user.installationIds.includes(repo.installation_id)) return null;
	return plan;
}

// GitHub is the source of truth for which installations this user may manage;
// D1 only supplies Turbodiff's per-repo settings and usage. Returns null after
// sending a redirect when the session is missing or the token expired.
async function requireUser(c: Context): Promise<AuthedUser | null> {
	// Local-only escape hatch for developing the signed-in UI without GitHub
	// OAuth: DEV_FAKE_INSTALLATIONS="1001,1002" in .dev.vars signs you in as
	// @dev with those installation ids. Guarded to loopback hosts so setting it
	// in production by mistake cannot become an auth bypass.
	const fake = (env as { DEV_FAKE_INSTALLATIONS?: string }).DEV_FAKE_INSTALLATIONS;
	const host = new URL(c.req.url).hostname;
	if (fake && (host === 'localhost' || host === '127.0.0.1')) {
		return {
			session: { userId: 0, login: 'dev', ghToken: '', exp: 0 },
			installationIds: fake.split(',').map(Number).filter((n) => Number.isInteger(n)),
		};
	}
	const session = await openSession(getCookie(c, SESSION_COOKIE));
	if (!session) return null;
	try {
		return { session, installationIds: await fetchUserInstallationIds(session.ghToken) };
	} catch {
		deleteCookie(c, SESSION_COOKIE, { path: '/' });
		return null;
	}
}

export function createSettingsRoutes() {
	const app = new Hono();

	app.get('/auth/login', (c) => {
		const state = randomToken();
		setCookie(c, STATE_COOKIE, state, {
			httpOnly: true,
			secure: true,
			sameSite: 'Lax',
			maxAge: 600,
			path: '/',
		});
		const redirectUri = new URL('/auth/callback', c.req.url).toString();
		return c.redirect(oauthAuthorizeUrl(redirectUri, state));
	});

	app.get('/auth/callback', async (c) => {
		const { code, state } = c.req.query();
		const expectedState = getCookie(c, STATE_COOKIE);
		deleteCookie(c, STATE_COOKIE, { path: '/' });
		if (!code || !state || !expectedState || state !== expectedState) {
			return c.text('OAuth state mismatch — start again at /', 400);
		}
		const redirectUri = new URL('/auth/callback', c.req.url).toString();
		const ghToken = await exchangeOAuthCode(code, redirectUri);
		const user = await fetchUser(ghToken);
		const session: Session = {
			userId: user.id,
			login: user.login,
			ghToken,
			exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
		};
		setCookie(c, SESSION_COOKIE, await sealSession(session), {
			httpOnly: true,
			secure: true,
			sameSite: 'Lax',
			maxAge: SESSION_TTL_SECONDS,
			path: '/',
		});
		return c.redirect('/');
	});

	app.post('/auth/logout', (c) => {
		deleteCookie(c, SESSION_COOKIE, { path: '/' });
		return c.redirect('/');
	});

	// Dashboard: headline metrics, monthly cost, per-repo cost, recent reviews.
	app.get('/', async (c) => {
		const user = await requireUser(c);
		if (!user) return c.html(renderLanding(env.GITHUB_APP_SLUG));
		const { session, installationIds } = user;

		const month = currentMonth();
		const [stats, months, repoUsage, agentUsage, groups, recent] = await Promise.all([
			dashboardStats(installationIds),
			monthlyUsage(installationIds, 6),
			repoUsageForMonth(installationIds, month),
			agentUsageForMonth(installationIds, month),
			listInstallationsWithRepos(installationIds),
			listRecentReviews(installationIds, 5),
		]);

		const repoCount = groups.reduce((n, g) => n + g.repos.length, 0);
		const enabledCount = groups.reduce((n, g) => n + g.repos.filter((r) => r.enabled).length, 0);
		const maxMonthCost = Math.max(...months.map((m) => m.cost_usd), 0);
		const usageByRepo = new Map(repoUsage.map((u) => [u.repository_id, u]));
		const anyRunning = recent.some((r) => reviewState(r) === 'running');

		// The 5 most recently connected repos; the rest live on /settings.
		const recentRepos = groups
			.flatMap(({ installation, repos }) => repos.map((repo) => ({ installation, repo })))
			.sort((a, b) => b.repo.created_at.localeCompare(a.repo.created_at))
			.slice(0, 5);

		return c.html(
			page(
				'Turbodiff — dashboard',
				html`${topbar(session.login)} ${tabs('dashboard')}

					<div class="tiles">
						<div class="tile">
							<div class="label">cost this month</div>
							<div class="value">${fmtUsd(stats.month_cost_usd)}</div>
							<div class="sub">${monthLabel(month)}</div>
						</div>
						<div class="tile">
							<div class="label">reviews this month</div>
							<div class="value">${stats.month_reviews}</div>
							<div class="sub">${stats.running > 0 ? html`${stats.running} running now` : html`&nbsp;`}</div>
						</div>
						<div class="tile">
							<div class="label">avg review time</div>
							<div class="value">${stats.avg_duration_s !== null ? fmtDuration(stats.avg_duration_s) : '—'}</div>
							<div class="sub">
								${fmtTokens(stats.month_tokens)} tokens this month${stats.avg_findings !== null
									? html` &middot; ${stats.avg_findings.toFixed(1)} findings/review`
									: ''}
							</div>
						</div>
						<div class="tile">
							<div class="label">connected repos</div>
							<div class="value">${repoCount}</div>
							<div class="sub">${enabledCount} with reviews on</div>
						</div>
					</div>

					<h2>monthly cost</h2>
					${months.length === 0
						? html`<p class="muted">No reviews yet — costs will accumulate here per calendar month.</p>`
						: html`<table>
								<tr>
									<th>month</th>
									<th style="width: 40%"></th>
									<th class="num">cost</th>
									<th class="num">reviews</th>
									<th class="num">tokens</th>
								</tr>
								${months.map(
									(m) => html`<tr>
										<td>${monthLabel(m.month)}</td>
										<td><span class="bar-track"><span
											class="bar"
											style="display:block; width:${maxMonthCost > 0 ? Math.max(1, Math.round((m.cost_usd / maxMonthCost) * 100)) : 1}%"
										></span></span></td>
										<td class="num">${fmtUsd(m.cost_usd)}</td>
										<td class="num">${m.reviews}</td>
										<td class="num">${fmtTokens(m.total_tokens)}</td>
									</tr>`,
								)}
							</table>`}

					${agentUsage.length > 0
						? html`<h2>cost by agent <span class="muted">(${monthLabel(month)})</span></h2>
								<table>
									<tr>
										<th>agent</th>
										<th class="num">reviews</th>
										<th class="num">cost</th>
									</tr>
									${agentUsage.map(
										(a) => html`<tr>
											<td>${a.agent_slug ?? html`<span class="muted">(pre-agent reviews)</span>`}</td>
											<td class="num">${a.reviews}</td>
											<td class="num">${a.cost_usd > 0 ? fmtUsd(a.cost_usd) : html`<span class="muted">—</span>`}</td>
										</tr>`,
									)}
								</table>`
						: ''}

					<h2>recent reviews</h2>
					${recent.length === 0
						? html`<p class="muted">No reviews yet — open a pull request on an enabled repository
								and it will show up here.</p>`
						: html`<table>
								${reviewsHead}
								${recent.map((r) => reviewRow(r))}
							</table>
							<p class="list-nav"><a class="button secondary" href="/reviews">view all reviews &rarr;</a></p>`}

					<h2>repositories</h2>
					${repoCount === 0
						? html`<p class="muted">No installations yet —
								<a href="https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new">install the app</a>
								on an organization or account.</p>`
						: html`<table>
								<tr>
									<th>repository</th>
									<th>auto-review</th>
									<th class="num">reviews (${monthLabel(month)})</th>
									<th class="num">cost (${monthLabel(month)})</th>
								</tr>
								${recentRepos.map(({ installation, repo: r }) => {
									const u = usageByRepo.get(r.id);
									return html`<tr>
										<td>${r.owner}/${r.name}
											${installation.suspended ? html`<span class="pill red">suspended</span>` : ''}</td>
										<td>${r.enabled ? html`<span class="pill on">on</span>` : html`<span class="pill">off</span>`}</td>
										<td class="num">${u ? u.reviews : html`<span class="muted">0</span>`}</td>
										<td class="num">${u && u.cost_usd > 0 ? fmtUsd(u.cost_usd) : html`<span class="muted">—</span>`}</td>
									</tr>`;
								})}
							</table>
							<p class="list-nav"><a class="button secondary" href="/settings">view all repos &rarr;</a></p>`}
					${anyRunning
						? html`<p class="muted">A review is running — this page refreshes every 10 seconds.</p>
								<script>
									setTimeout(function () { location.reload(); }, 10000);
								</script>`
						: ''}`,
			),
		);
	});

	// Factory (Phase 3): submit a feature as requirements, answer the planning
	// agent's questions, approve the plan, and it generates a PR.
	app.get('/factory', async (c) => {
		const user = await requireUser(c);
		if (!user) return c.redirect('/auth/login');
		const { session, installationIds } = user;

		const [groups, plans] = await Promise.all([
			listInstallationsWithRepos(installationIds),
			listPlansForInstallations(installationIds),
		]);
		const repos = groups.flatMap((g) => g.repos).filter((r) => r.enabled);

		return c.html(
			page(
				'Turbodiff — factory',
				html`${topbar(session.login)} ${tabs('factory')}
					<h2>new feature</h2>
					${repos.length === 0
						? html`<p class="muted">
								Enable reviews on a repository in
								<a href="/settings">settings</a> to plan features for it.
							</p>`
						: html`<form method="post" action="/factory/plans">
								<label
									>repository
									<select name="repo" required>
										${repos.map((r) => html`<option value="${r.owner}/${r.name}">${r.owner}/${r.name}</option>`)}
									</select>
								</label>
								<label
									>title
									<input type="text" name="title" required placeholder="short feature name" />
								</label>
								<label
									>requirements
									<textarea
										name="requirements"
										required
										placeholder="Describe what you want built. The planning agent reads your repo, asks clarifying questions, and drafts a plan you approve before any code is written."
									></textarea>
								</label>
								<p style="margin-top:0.75rem"><button type="submit">Plan feature</button></p>
							</form>`}
					<h2>plans <span class="muted">(${plans.length})</span></h2>
					${plans.length === 0
						? html`<p class="muted">No plans yet.</p>`
						: plans.map((p) => renderPlan(p))}`,
			),
		);
	});

	app.post('/factory/plans', async (c) => {
		const user = await requireUser(c);
		if (!user) return c.redirect('/auth/login');
		const form = await c.req.parseBody();
		const repo = typeof form.repo === 'string' ? form.repo : '';
		const title = typeof form.title === 'string' ? form.title.trim() : '';
		const requirements = typeof form.requirements === 'string' ? form.requirements.trim() : '';
		const match = repo.match(/^([\w.-]+)\/([\w.-]+)$/);
		if (!match || !title || !requirements) return c.redirect('/factory');

		const row = await getRepoByFullName(match[1], match[2]);
		if (!row || !user.installationIds.includes(row.installation_id)) {
			return c.text('unknown repository', 404);
		}
		const planId = await createPlan(row.id, title, requirements);
		await env.FACTORY_QUEUE.send({ kind: 'plan_analyze', planId });
		return c.redirect('/factory');
	});

	app.post('/factory/plans/:id/answers', async (c) => {
		const user = await requireUser(c);
		if (!user) return c.redirect('/auth/login');
		const plan = await authorizedPlan(c, user);
		if (!plan) return c.text('unknown plan', 404);
		if (plan.status !== 'awaiting_answers') return c.redirect('/factory');

		const form = await c.req.parseBody();
		const questions: string[] = plan.questions ? JSON.parse(plan.questions) : [];
		const answers = questions.map((_, i) => {
			const a = form[`answer_${i}`];
			return typeof a === 'string' ? a : '';
		});
		await updatePlan(plan.id, { status: 'refining', answers: JSON.stringify(answers) });
		await env.FACTORY_QUEUE.send({ kind: 'plan_refine', planId: plan.id });
		return c.redirect('/factory');
	});

	app.post('/factory/plans/:id/approve', async (c) => {
		const user = await requireUser(c);
		if (!user) return c.redirect('/auth/login');
		const plan = await authorizedPlan(c, user);
		if (!plan) return c.text('unknown plan', 404);

		const featureId = await approvePlan(plan.id);
		if (featureId !== null) await env.FACTORY_QUEUE.send({ kind: 'generate', featureId });
		return c.redirect('/factory');
	});

	// Full review history, newest first, paginated.
	const PER_PAGE = 25;
	app.get('/reviews', async (c) => {
		const user = await requireUser(c);
		if (!user) return c.redirect('/auth/login');
		const { session, installationIds } = user;

		const total = await countReviews(installationIds);
		const pages = Math.max(1, Math.ceil(total / PER_PAGE));
		const pageNo = Math.min(pages, Math.max(1, Number(c.req.query('page')) || 1));
		const reviews = await listRecentReviews(installationIds, PER_PAGE, (pageNo - 1) * PER_PAGE);
		const anyRunning = reviews.some((r) => reviewState(r) === 'running');

		return c.html(
			page(
				'Turbodiff — reviews',
				html`${topbar(session.login)} ${tabs('reviews')}
					<h2>all reviews <span class="muted">(${total})</span></h2>
					${reviews.length === 0
						? html`<p class="muted">No reviews yet — open a pull request on an enabled repository
								and it will show up here.</p>`
						: html`<table>
								${reviewsHead}
								${reviews.map((r) => reviewRow(r))}
							</table>`}
					${pages > 1
						? html`<div class="pager">
								<span>${pageNo > 1 ? html`<a href="/reviews?page=${pageNo - 1}">&larr; newer</a>` : html`&nbsp;`}</span>
								<span class="muted">page ${pageNo} of ${pages}</span>
								<span>${pageNo < pages ? html`<a href="/reviews?page=${pageNo + 1}">older &rarr;</a>` : html`&nbsp;`}</span>
							</div>`
						: ''}
					${anyRunning
						? html`<p class="muted">A review is running — this page refreshes every 10 seconds.</p>
								<script>
									setTimeout(function () { location.reload(); }, 10000);
								</script>`
						: ''}`,
			),
		);
	});

	// --- Agents: list, create, edit, delete (design: docs/custom-agents-design.md) ---

	const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
	// Gateway-only model ids: cloudflare/<provider>/<model>.
	const MODEL_RE = /^cloudflare\/[\w.-]+\/[\w.:-]+$/;

	interface AgentFormValues {
		name: string;
		slug: string;
		description: string;
		instructions: string;
		model: string;
	}

	function agentForm(opts: {
		action: string;
		values: AgentFormValues;
		slugEditable: boolean;
		error?: string;
		deleteAction?: string;
	}) {
		return html`<form method="post" action="${opts.action}" style="display: block;">
				<label>name
					<input type="text" name="name" value="${opts.values.name}" required maxlength="60" />
				</label>
				<label>slug <span class="muted">(mention handle: @turbodiff &lt;slug&gt;; lowercase letters, digits, dashes${opts.slugEditable ? '' : '; fixed after creation'})</span>
					<input type="text" name="slug" value="${opts.values.slug}" ${opts.slugEditable ? '' : 'readonly'} required maxlength="31" />
				</label>
				<label>description <span class="muted">(shown in lists)</span>
					<input type="text" name="description" value="${opts.values.description}" maxlength="200" />
				</label>
				<label>focus instructions <span class="muted">(what this agent hunts for — process and posting rules are fixed)</span>
					<textarea name="instructions" required>${opts.values.instructions}</textarea>
				</label>
				<label>model <span class="muted">(any AI Gateway model id; default ${DEFAULT_MODEL})</span>
					<input type="text" name="model" value="${opts.values.model}" required />
				</label>
				${opts.error ? html`<p class="form-error">${opts.error}</p>` : ''}
				<p style="margin-top: 1.25rem;"><button>Save agent</button> <a class="button secondary" href="/agents">Cancel</a></p>
			</form>
			${opts.deleteAction
				? html`<form method="post" action="${opts.deleteAction}"
						onsubmit="return confirm('Delete this agent? Its review history stays.');">
						<button class="secondary">Delete agent</button>
					</form>`
				: ''}`;
	}

	async function readAgentForm(c: Context): Promise<AgentFormValues> {
		const form = await c.req.formData();
		const get = (k: string) => String(form.get(k) ?? '').trim();
		return {
			name: get('name'),
			slug: get('slug').toLowerCase(),
			description: get('description'),
			instructions: get('instructions'),
			model: get('model') || DEFAULT_MODEL,
		};
	}

	function validateAgentForm(v: AgentFormValues, checkSlug: boolean): string | null {
		if (!v.name) return 'name is required';
		if (checkSlug && !SLUG_RE.test(v.slug)) return 'slug must be 2-31 chars: lowercase letters, digits, dashes';
		if (checkSlug && RESERVED_AGENT_SLUGS.has(v.slug)) return `"${v.slug}" is a reserved word`;
		if (!v.instructions) return 'instructions are required';
		if (!MODEL_RE.test(v.model)) return 'model must be an AI Gateway id like cloudflare/anthropic/claude-sonnet-5';
		return null;
	}

	app.get('/agents', async (c) => {
		const user = await requireUser(c);
		if (!user) return c.redirect('/auth/login');
		const { session, installationIds } = user;
		await Promise.all(installationIds.map((id) => ensureBuiltinAgents(id)));
		const [groups, agents] = await Promise.all([
			listInstallationsWithRepos(installationIds),
			listAgents(installationIds),
		]);

		return c.html(
			page(
				'Turbodiff — agents',
				html`${topbar(session.login)} ${tabs('agents')}
					<p class="muted" style="margin-top: 1.25rem;">
						Agents run on every PR of the repos they're enabled for (see
						<a href="/settings">settings</a>), or on demand via
						<code>@${env.GITHUB_APP_SLUG} &lt;slug&gt;</code> in a PR comment.
					</p>
					${groups.map(({ installation }) => {
						const own = agents.filter((a) => a.installation_id === installation.id);
						return html`<h2>${installation.account_login}
								<a class="drill" href="/agents/new?installation=${installation.id}"></a></h2>
							<p><a class="button secondary" href="/agents/new?installation=${installation.id}">New agent</a></p>
							<table>
								<tr><th>agent</th><th>slug</th><th>model</th><th class="num"></th></tr>
								${own.map(
									(a) => html`<tr>
										<td>${a.name} ${a.is_builtin ? html`<span class="pill">built-in</span>` : ''}
											${a.description ? html`<div class="muted">${a.description}</div>` : ''}</td>
										<td><span class="pill">${a.slug}</span></td>
										<td class="muted">${a.model.replace('cloudflare/', '')}</td>
										<td class="num"><a href="/agents/${a.id}/edit">edit</a></td>
									</tr>`,
								)}
							</table>`;
					})}`,
			),
		);
	});

	app.get('/agents/new', async (c) => {
		const user = await requireUser(c);
		if (!user) return c.redirect('/auth/login');
		const installationId = Number(c.req.query('installation'));
		if (!user.installationIds.includes(installationId)) return c.text('unknown installation', 404);

		return c.html(
			page(
				'Turbodiff — new agent',
				html`${topbar(user.session.login)} ${tabs('agents')}
					<h2>new agent</h2>
					${agentForm({
						action: `/agents/new?installation=${installationId}`,
						values: { name: '', slug: '', description: '', instructions: '', model: DEFAULT_MODEL },
						slugEditable: true,
					})}`,
			),
		);
	});

	app.post('/agents/new', async (c) => {
		const user = await requireUser(c);
		if (!user) return c.redirect('/auth/login');
		const installationId = Number(c.req.query('installation'));
		if (!user.installationIds.includes(installationId)) return c.text('unknown installation', 404);

		const values = await readAgentForm(c);
		let error = validateAgentForm(values, true);
		if (!error && (await getAgentBySlug(installationId, values.slug))) {
			error = `an agent with slug "${values.slug}" already exists`;
		}
		if (error) {
			return c.html(
				page(
					'Turbodiff — new agent',
					html`${topbar(user.session.login)} ${tabs('agents')}
						<h2>new agent</h2>
						${agentForm({ action: `/agents/new?installation=${installationId}`, values, slugEditable: true, error })}`,
				),
				400,
			);
		}
		await createAgent(installationId, values);
		return c.redirect('/agents');
	});

	// Resolves an agent id from the URL and checks the signed-in user may
	// manage it; null means the response was already sent.
	async function requireAgent(c: Context, user: AuthedUser): Promise<AgentRow | null> {
		const id = Number(c.req.param('id'));
		const agent = Number.isInteger(id) ? await getAgentById(id) : null;
		if (!agent || !user.installationIds.includes(agent.installation_id)) return null;
		return agent;
	}

	function connectionsSection(agent: AgentRow, connections: AgentConnectionRow[], error?: string) {
		return html`<h2>external tools <span class="muted">(MCP)</span></h2>
			<p class="muted">
				Give this agent extra tools by connecting remote MCP servers — e.g. your
				<a href="https://executor.sh">Executor</a> catalog endpoint (one URL + token for all
				your integrations, with per-tool policies managed there). Tokens are encrypted and
				write-only. Anything a connected server returns is treated as untrusted content, and
				a connected server does see PR context the agent sends it — connect only servers you
				control or trust.
			</p>
			${connections.length > 0
				? html`<table>
						<tr><th>server</th><th>tools</th><th>auth</th><th class="num"></th></tr>
						${connections.map((conn) => {
							const snap = connectionSnapshot(conn);
							return html`<tr>
								<td><span class="pill">${conn.name}</span>
									<div class="muted">${conn.url}</div></td>
								<td class="muted">${snap.tools ? snap.tools.join(', ') : 'all tools'}</td>
								<td>${conn.auth_ciphertext ? html`<span class="pill on">token set</span>` : html`<span class="pill">none</span>`}</td>
								<td class="num">
									<form method="post" action="/agents/${agent.id}/connections/${conn.id}/test"><button class="secondary">Test</button></form>
									<form method="post" action="/agents/${agent.id}/connections/${conn.id}/delete"
										onsubmit="return confirm('Remove this connection?');"><button class="secondary">Remove</button></form>
								</td>
							</tr>`;
						})}
					</table>`
				: html`<p class="muted">No connections yet.</p>`}
			<form method="post" action="/agents/${agent.id}/connections" style="display: block; margin-top: 1rem;">
				<label>server name <span class="muted">(tools mount as mcp__&lt;name&gt;__&lt;tool&gt;)</span>
					<input type="text" name="name" required maxlength="31" placeholder="executor" />
				</label>
				<label>endpoint URL <span class="muted">(https; the server's MCP endpoint)</span>
					<input type="text" name="url" required placeholder="https://mcp.executor.sh/..." />
				</label>
				<label>bearer token <span class="muted">(optional; stored encrypted, never shown again)</span>
					<input type="text" name="token" autocomplete="off" />
				</label>
				<label>tool allowlist <span class="muted">(optional, comma-separated server tool names; empty = all)</span>
					<input type="text" name="tools" placeholder="search_deps, check_license" />
				</label>
				${error ? html`<p class="form-error">${error}</p>` : ''}
				<p style="margin-top: 1.25rem;"><button>Add connection</button></p>
			</form>`;
	}

	async function renderAgentEditPage(
		c: Context,
		login: string,
		agent: AgentRow,
		opts: { connError?: string; status?: 200 | 400 } = {},
	) {
		const connections = await listAgentConnections(agent.id);
		return c.html(
			page(
				'Turbodiff — edit agent',
				html`${topbar(login)} ${tabs('agents')}
					<h2>edit agent ${agent.is_builtin ? html`<span class="pill">built-in</span>` : ''}</h2>
					${agentForm({
						action: `/agents/${agent.id}/edit`,
						values: {
							name: agent.name,
							slug: agent.slug,
							description: agent.description ?? '',
							instructions: agent.instructions,
							model: agent.model,
						},
						slugEditable: false,
						deleteAction: agent.is_builtin ? undefined : `/agents/${agent.id}/delete`,
					})}
					${connectionsSection(agent, connections, opts.connError)}`,
			),
			opts.status ?? 200,
		);
	}

	app.get('/agents/:id/edit', async (c) => {
		const user = await requireUser(c);
		if (!user) return c.redirect('/auth/login');
		const agent = await requireAgent(c, user);
		if (!agent) return c.text('unknown agent', 404);
		return renderAgentEditPage(c, user.session.login, agent);
	});

	app.post('/agents/:id/edit', async (c) => {
		const user = await requireUser(c);
		if (!user) return c.redirect('/auth/login');
		const agent = await requireAgent(c, user);
		if (!agent) return c.text('unknown agent', 404);

		const values = await readAgentForm(c);
		const error = validateAgentForm(values, false);
		if (error) {
			return c.html(
				page(
					'Turbodiff — edit agent',
					html`${topbar(user.session.login)} ${tabs('agents')}
						<h2>edit agent</h2>
						${agentForm({ action: `/agents/${agent.id}/edit`, values: { ...values, slug: agent.slug }, slugEditable: false, error })}`,
				),
				400,
			);
		}
		await updateAgent(agent.id, values);
		return c.redirect('/agents');
	});

	app.post('/agents/:id/delete', async (c) => {
		const user = await requireUser(c);
		if (!user) return c.redirect('/auth/login');
		const agent = await requireAgent(c, user);
		if (!agent) return c.text('unknown agent', 404);
		if (agent.is_builtin) return c.text('built-in agents cannot be deleted', 403);
		await deleteAgent(agent.id);
		return c.redirect('/agents');
	});

	// --- Agent MCP connections ---

	const CONNECTION_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,30}$/;

	function validConnectionUrl(raw: string): boolean {
		try {
			const url = new URL(raw);
			if (url.protocol === 'https:') return true;
			// Plain http only for local development targets.
			return url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
		} catch {
			return false;
		}
	}

	app.post('/agents/:id/connections', async (c) => {
		const user = await requireUser(c);
		if (!user) return c.redirect('/auth/login');
		const agent = await requireAgent(c, user);
		if (!agent) return c.text('unknown agent', 404);

		const form = await c.req.formData();
		const get = (k: string) => String(form.get(k) ?? '').trim();
		const name = get('name').toLowerCase();
		const url = get('url');
		const token = get('token');
		const tools = get('tools')
			.split(',')
			.map((t) => t.trim())
			.filter(Boolean);

		let error: string | null = null;
		if (!CONNECTION_NAME_RE.test(name)) {
			error = 'server name must be 1-31 chars: lowercase letters, digits, dashes, underscores';
		} else if (!validConnectionUrl(url)) {
			error = 'endpoint must be an https:// URL';
		} else if (token && !encryptionConfigured()) {
			error =
				'token storage needs the TOKEN_ENCRYPTION_KEY secret (openssl rand -hex 32, then wrangler secret put TOKEN_ENCRYPTION_KEY)';
		} else if ((await listAgentConnections(agent.id)).some((conn) => conn.name === name)) {
			error = `a connection named "${name}" already exists on this agent`;
		}
		if (error) {
			return renderAgentEditPage(c, user.session.login, agent, { connError: error, status: 400 });
		}

		await createAgentConnection(agent.id, {
			name,
			url,
			toolAllowlist: tools.length > 0 ? tools : null,
			authCiphertext: token ? await sealToken(token) : null,
			optional: true,
		});
		return c.redirect(`/agents/${agent.id}/edit`);
	});

	// Resolves a connection under an agent the user may manage.
	async function requireConnection(c: Context, agent: AgentRow): Promise<AgentConnectionRow | null> {
		const id = Number(c.req.param('cid'));
		const conn = Number.isInteger(id) ? await getAgentConnection(id) : null;
		return conn && conn.agent_id === agent.id ? conn : null;
	}

	app.post('/agents/:id/connections/:cid/delete', async (c) => {
		const user = await requireUser(c);
		if (!user) return c.redirect('/auth/login');
		const agent = await requireAgent(c, user);
		if (!agent) return c.text('unknown agent', 404);
		const conn = await requireConnection(c, agent);
		if (!conn) return c.text('unknown connection', 404);
		await deleteAgentConnection(conn.id);
		return c.redirect(`/agents/${agent.id}/edit`);
	});

	// Handshakes the server (initialize + tools/list) and reports what the
	// agent would see — without mounting anything.
	app.post('/agents/:id/connections/:cid/test', async (c) => {
		const user = await requireUser(c);
		if (!user) return c.redirect('/auth/login');
		const agent = await requireAgent(c, user);
		if (!agent) return c.text('unknown agent', 404);
		const conn = await requireConnection(c, agent);
		if (!conn) return c.text('unknown connection', 404);

		const token = conn.auth_ciphertext ? await openToken(conn.auth_ciphertext) : undefined;
		const result = await testMcpEndpoint(conn.url, token);
		return c.html(
			page(
				'Turbodiff — connection test',
				html`${topbar(user.session.login)} ${tabs('agents')}
					<h2>connection test <span class="pill">${conn.name}</span></h2>
					<p>${result.ok ? html`<span class="pill on">ok</span>` : html`<span class="pill red">failed</span>`}
						${result.detail}</p>
					${result.tools && result.tools.length > 0
						? html`<table>
								<tr><th>tool</th><th>mounts as</th></tr>
								${result.tools.map(
									(t) => html`<tr>
										<td>${t}</td>
										<td class="muted">mcp__${conn.name}__${t}</td>
									</tr>`,
								)}
							</table>`
						: ''}
					<p style="margin-top: 1.25rem;"><a class="button secondary" href="/agents/${agent.id}/edit">&larr; back to agent</a></p>`,
			),
		);
	});

	// Per-repo config: master auto-review switch plus per-agent toggles.
	app.get('/settings', async (c) => {
		const user = await requireUser(c);
		if (!user) return c.redirect('/auth/login');
		const { session, installationIds } = user;
		await Promise.all(installationIds.map((id) => ensureBuiltinAgents(id)));
		const [groups, agents, overrides] = await Promise.all([
			listInstallationsWithRepos(installationIds),
			listAgents(installationIds),
			listRepoAgentOverrides(installationIds),
		]);
		const overrideMap = new Map(
			overrides.map((o) => [`${o.repository_id}:${o.agent_id}`, o.enabled]),
		);

		return c.html(
			page(
				'Turbodiff — settings',
				html`${topbar(session.login)} ${tabs('settings')}
					<p style="margin-top: 1.25rem;">
						<a class="button secondary" href="https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new">
							Add or manage repositories on GitHub
						</a>
					</p>
					${groups.length === 0
						? html`<p class="muted">No installations yet — install the app on an organization or
								account, then come back here.</p>`
						: groups.map(({ installation, repos }) => {
								const instAgents = agents.filter((a) => a.installation_id === installation.id);
								return html`<h2>
										${installation.account_login}
										${installation.suspended ? html`<span class="pill red">suspended</span>` : ''}
									</h2>
									<table>
										${repos.length === 0
											? html`<tr><td class="muted">No repositories selected in this installation.</td></tr>`
											: repos.map(
													(r) => html`<tr>
														<td>
															${r.owner}/${r.name}
															${r.enabled
																? html`<div class="chips">
																		${instAgents.map((a) => {
																			const on = resolveAgentEnabled(a, overrideMap.get(`${r.id}:${a.id}`));
																			return html`<form method="post" action="/repos/${r.id}/agents/${a.id}/toggle">
																				<button class="chip ${on ? 'on' : ''}" title="${on ? 'disable' : 'enable'} ${a.name} on this repo">
																					${a.slug}
																				</button>
																			</form>`;
																		})}
																		<form method="post" action="/repos/${r.id}/push-toggle">
																			<button
																				class="chip ${r.review_on_push ? 'on' : ''}"
																				title="${r.review_on_push ? 'stop' : 'start'} re-reviewing this repo's PRs when new commits are pushed (debounced)"
																			>
																				&#8635; on push
																			</button>
																		</form>
																		<form method="post" action="/repos/${r.id}/blocking-toggle">
																			<button
																				class="chip ${r.blocking_reviews ? 'on' : ''}"
																				title="${r.blocking_reviews
																					? 'reviews post as plain comments'
																					: 'P1 findings request changes; clean reviews approve'} — click to ${r.blocking_reviews ? 'disable' : 'enable'}"
																			>
																				&#9940; blocking
																			</button>
																		</form>
																		<form method="post" action="/repos/${r.id}/autofix-toggle">
																			<button
																				class="chip ${r.auto_fix ? 'on' : ''}"
																				title="${r.auto_fix
																					? 'blocking reviews are left for a human to address'
																					: 'a blocking review dispatches the fix agent to address the findings (max 3 runs per PR)'} — click to ${r.auto_fix ? 'disable' : 'enable'}"
																			>
																				&#128295; auto-fix
																			</button>
																		</form>
																		<form method="post" action="/repos/${r.id}/automerge-toggle">
																			<button
																				class="chip ${r.auto_merge ? 'on' : ''}"
																				title="${r.auto_merge
																					? 'factory PRs stay open for a human to merge'
																					: 'factory PRs merge automatically once verification passes and the review is clean (requires blocking reviews)'} — click to ${r.auto_merge ? 'disable' : 'enable'}"
																			>
																				&#127981; auto-merge
																			</button>
																		</form>
																		<form method="post" action="/repos/${r.id}/check-command" class="check-cmd">
																			<input
																				type="text"
																				name="command"
																				value="${r.check_command ?? ''}"
																				placeholder="check command (e.g. npm ci && npm test) — blocks factory pushes on failure"
																			/>
																			<button class="chip">save</button>
																		</form>
																	</div>`
																: ''}
														</td>
														<td class="num">
															<form method="post" action="/repos/${r.id}/toggle">
																<button class="${r.enabled ? 'secondary' : ''}">
																	${r.enabled ? 'Disable reviews' : 'Enable reviews'}
																</button>
															</form>
														</td>
													</tr>`,
												)}
									</table>`;
							})}`,
			),
		);
	});

	app.post('/repos/:id/agents/:agentId/toggle', async (c) => {
		const user = await requireUser(c);
		if (!user) return c.redirect('/auth/login');

		const repoId = Number(c.req.param('id'));
		const repo = Number.isInteger(repoId) ? await getRepoById(repoId) : null;
		if (!repo || !user.installationIds.includes(repo.installation_id)) {
			return c.text('unknown repository', 404);
		}

		const agentId = Number(c.req.param('agentId'));
		const agent = Number.isInteger(agentId) ? await getAgentById(agentId) : null;
		if (!agent || agent.installation_id !== repo.installation_id) {
			return c.text('unknown agent', 404);
		}

		const overrides = await listRepoAgentOverrides([repo.installation_id]);
		const current = resolveAgentEnabled(
			agent,
			overrides.find((o) => o.repository_id === repo.id && o.agent_id === agent.id)?.enabled,
		);
		await setRepoAgentEnabled(repo.id, agent.id, !current);
		return c.redirect('/settings');
	});

	app.post('/repos/:id/push-toggle', async (c) => {
		const user = await requireUser(c);
		if (!user) return c.redirect('/auth/login');

		const repoId = Number(c.req.param('id'));
		const repo = Number.isInteger(repoId) ? await getRepoById(repoId) : null;
		if (!repo || !user.installationIds.includes(repo.installation_id)) {
			return c.text('unknown repository', 404);
		}

		await setRepoReviewOnPush(repo.id, !repo.review_on_push);
		return c.redirect('/settings');
	});

	app.post('/repos/:id/blocking-toggle', async (c) => {
		const user = await requireUser(c);
		if (!user) return c.redirect('/auth/login');

		const repoId = Number(c.req.param('id'));
		const repo = Number.isInteger(repoId) ? await getRepoById(repoId) : null;
		if (!repo || !user.installationIds.includes(repo.installation_id)) {
			return c.text('unknown repository', 404);
		}

		await setRepoBlockingReviews(repo.id, !repo.blocking_reviews);
		return c.redirect('/settings');
	});

	app.post('/repos/:id/autofix-toggle', async (c) => {
		const user = await requireUser(c);
		if (!user) return c.redirect('/auth/login');

		const repoId = Number(c.req.param('id'));
		const repo = Number.isInteger(repoId) ? await getRepoById(repoId) : null;
		if (!repo || !user.installationIds.includes(repo.installation_id)) {
			return c.text('unknown repository', 404);
		}

		await setRepoAutoFix(repo.id, !repo.auto_fix);
		return c.redirect('/settings');
	});

	app.post('/repos/:id/automerge-toggle', async (c) => {
		const user = await requireUser(c);
		if (!user) return c.redirect('/auth/login');

		const repoId = Number(c.req.param('id'));
		const repo = Number.isInteger(repoId) ? await getRepoById(repoId) : null;
		if (!repo || !user.installationIds.includes(repo.installation_id)) {
			return c.text('unknown repository', 404);
		}

		await setRepoAutoMerge(repo.id, !repo.auto_merge);
		return c.redirect('/settings');
	});

	app.post('/repos/:id/check-command', async (c) => {
		const user = await requireUser(c);
		if (!user) return c.redirect('/auth/login');

		const repoId = Number(c.req.param('id'));
		const repo = Number.isInteger(repoId) ? await getRepoById(repoId) : null;
		if (!repo || !user.installationIds.includes(repo.installation_id)) {
			return c.text('unknown repository', 404);
		}

		const form = await c.req.parseBody();
		await setRepoCheckCommand(repo.id, typeof form.command === 'string' ? form.command : '');
		return c.redirect('/settings');
	});

	app.post('/repos/:id/toggle', async (c) => {
		const user = await requireUser(c);
		if (!user) return c.redirect('/auth/login');

		const repoId = Number(c.req.param('id'));
		const repo = Number.isInteger(repoId) ? await getRepoById(repoId) : null;
		if (!repo) return c.text('unknown repository', 404);

		if (!user.installationIds.includes(repo.installation_id)) {
			return c.text('you do not have access to this repository', 403);
		}

		await setRepoEnabled(repo.id, !repo.enabled);
		return c.redirect('/settings');
	});

	// --- Factory PR cockpit (v1, server-rendered) ---
	// One screen for reviewing a factory PR without GitHub: demo video, full
	// diff (SSR-rendered via @pierre/diffs), acceptance evidence, review
	// verdicts, and the merge action. GitHub stays the system of record; this
	// is the review surface. v2 hydrates this markup with @pierre/diffs/react
	// for inline commenting that feeds the fix loop.

	app.get('/factory/features/:id', async (c) => {
		const user = await requireUser(c);
		if (!user) return c.redirect('/auth/login');

		const id = Number(c.req.param('id'));
		const feature = Number.isInteger(id) ? await getFeature(id) : null;
		const repo = feature ? await getRepoById(feature.repository_id) : null;
		if (!feature || !repo || !user.installationIds.includes(repo.installation_id)) {
			return c.text('unknown feature', 404);
		}
		if (!feature.pr_number) {
			return c.html(
				page(
					`Turbodiff — ${feature.title}`,
					html`${topbar(user.session.login)} ${tabs('factory')}
						<h2>${feature.title}</h2>
						<p class="muted">No pull request yet — generation is ${feature.status}.</p>`,
				),
			);
		}

		const [plan, verification, token, cockpitComments] = await Promise.all([
			getPlanByFeatureId(feature.id),
			latestVerificationForFeature(feature.id),
			installationToken(repo.installation_id),
			listCockpitComments(feature.id),
		]);
		const base = `/repos/${repo.owner}/${repo.name}`;
		const [prMeta, prFiles, prReviews] = await Promise.all([
			gh(token, `${base}/pulls/${feature.pr_number}`).then(
				(r) =>
					r.json() as Promise<{
						state: string;
						merged: boolean;
						html_url: string;
						additions: number;
						deletions: number;
						changed_files: number;
					}>,
			),
			gh(token, `${base}/pulls/${feature.pr_number}/files?per_page=100`).then(
				(r) =>
					r.json() as Promise<
						{ filename: string; status: string; additions: number; deletions: number; patch?: string }[]
					>,
			),
			gh(token, `${base}/pulls/${feature.pr_number}/reviews?per_page=100`).then(
				(r) =>
					r.json() as Promise<{ state: string; body: string; user: { login: string } | null }[]>,
			),
		]);

		// SSR-render each file's diff. GitHub's per-file patch lacks git headers,
		// so wrap it into a minimal single-file patch for the parser.
		const MAX_FILES = 50;
		const rendered: { filename: string; status: string; html: string | null }[] = [];
		for (const f of prFiles.slice(0, MAX_FILES)) {
			let diffHtml: string | null = null;
			if (f.patch && f.patch.length < 100_000) {
				try {
					const pseudo = `diff --git a/${f.filename} b/${f.filename}\n--- a/${f.filename}\n+++ b/${f.filename}\n${f.patch}\n`;
					const fileDiff = parsePatchFiles(pseudo)[0]?.files[0];
					if (fileDiff) {
						diffHtml = await preloadDiffHTML({ fileDiff, options: { theme: 'pierre-dark' } });
					}
				} catch (err) {
					console.warn(`turbodiff: cockpit diff render failed for ${f.filename}:`, err);
				}
			}
			rendered.push({ filename: f.filename, status: f.status, html: diffHtml });
		}

		// The library's stylesheet targets :host (web components); rescope it to
		// a wrapper class for light-DOM embedding.
		const diffsCss = wrapCoreCSS('').replaceAll(':host', '.diffs-scope');

		const demo = verification?.demo ? (JSON.parse(verification.demo) as { video?: string; caption?: string }) : null;
		const demoUrl = demo?.video
			? `/artifacts/${demo.video}?sig=${await signArtifactKey(demo.video)}`
			: null;
		const criteria: string[] = feature.acceptance ? JSON.parse(feature.acceptance) : [];
		const results: { index: number; verdict: string; note: string; screenshot?: string }[] =
			verification?.results ? JSON.parse(verification.results) : [];
		const shotUrl = new Map<string, string>();
		for (const r of results) {
			if (r.screenshot) {
				const key = `verify/${feature.id}/${r.screenshot.replace(/[^\w.-]/g, '')}`;
				shotUrl.set(r.screenshot, `/artifacts/${key}?sig=${await signArtifactKey(key)}`);
			}
		}
		const verdictBadge: Record<string, string> = { pass: '✅', fail: '❌', skip: '⚪' };
		const prState = prMeta.merged ? 'merged' : prMeta.state;

		return c.html(
			page(
				`Turbodiff — ${feature.title}`,
				html`${topbar(user.session.login)} ${tabs('factory')}
					<style>
						${raw(diffsCss)}
						.diffs-scope { display: block; margin-top: 0.5rem; border: 1px solid #1c2620; border-radius: 8px; overflow: hidden; }
						.cockpit-video { width: 100%; border: 1px solid #1c2620; border-radius: 8px; margin-top: 0.5rem; background: #000; }
						.file-label { margin-top: 1.25rem; font-size: 0.8rem; color: #b8c4bc; }
						details.review-body pre { white-space: pre-wrap; font-size: 0.8rem; }
						.cockpit-comment { border: 1px solid #2a3830; border-left: 3px solid #3fb950; border-radius: 6px; background: #0a100d; padding: 0.6rem 0.8rem; margin: 0.3rem 0.5rem; font-size: 0.82rem; }
						.cockpit-comment-head { color: #7d8f85; font-size: 0.75rem; margin-bottom: 0.25rem; }
						.cockpit-composer textarea { min-height: 4.5rem; }
						.cockpit-composer-actions { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
					</style>
					<div class="topbar" style="margin-top:1.5rem">
						<h1 style="margin:0">${feature.title}</h1>
						<span class="pill ${prState === 'merged' ? 'on' : prState === 'open' ? 'running' : 'red'}">${prState}</span>
					</div>
					<p class="muted">
						${repo.owner}/${repo.name} · PR
						<a href="${prMeta.html_url}" target="_blank" rel="noopener">#${feature.pr_number}</a> ·
						${prMeta.changed_files} files, +${prMeta.additions} −${prMeta.deletions}
						${renderVerificationInline(verification?.status ?? null, results)}
					</p>
					${prState === 'open'
						? html`<form method="post" action="/factory/features/${feature.id}/merge">
								<button
									onclick="return confirm('Merge this pull request?')"
								>
									Merge pull request
								</button>
							</form>`
						: ''}
					${demoUrl
						? html`<h2>demo</h2>
								${demo?.caption ? html`<p class="muted">${demo.caption}</p>` : ''}
								<video class="cockpit-video" controls autoplay muted loop playsinline src="${demoUrl}"></video>`
						: ''}
					${criteria.length > 0
						? html`<h2>acceptance criteria</h2>
								<table>
									${criteria.map((crit, i) => {
										const r = results.find((x) => x.index === i);
										const shot = r?.screenshot ? shotUrl.get(r.screenshot) : undefined;
										return html`<tr>
											<td style="width:1.5rem">${verdictBadge[r?.verdict ?? ''] ?? '⚪'}</td>
											<td>
												${crit}
												${r?.note ? html`<div class="muted">${r.note}</div>` : ''}
												${shot
													? html`<div><a href="${shot}" target="_blank" rel="noopener">screenshot →</a></div>`
													: ''}
											</td>
										</tr>`;
									})}
								</table>`
						: ''}
					${prReviews.length > 0
						? html`<h2>reviews</h2>
								${prReviews.map(
									(r) => html`<details class="review-body">
										<summary>
											${r.user?.login ?? 'unknown'} · ${r.state.toLowerCase()}
										</summary>
										<pre>${r.body || '(no body)'}</pre>
									</details>`,
								)}`
						: ''}
					${plan
						? html`<h2>plan</h2>
								<details class="review-body">
									<summary class="muted">implementation plan (approved)</summary>
									<pre>${plan.plan ?? ''}</pre>
								</details>`
						: ''}
					<h2>diff</h2>
					<script id="cockpit-data" type="application/json">
						${raw(
							JSON.stringify({
								featureId: feature.id,
								prOpen: prState === 'open',
								files: prFiles.slice(0, MAX_FILES).map((f) => ({
									filename: f.filename,
									status: f.status,
									patch:
										f.patch && f.patch.length < 100_000
											? `diff --git a/${f.filename} b/${f.filename}\n--- a/${f.filename}\n+++ b/${f.filename}\n${f.patch}\n`
											: null,
								})),
								comments: cockpitComments,
							}).replaceAll('</', '<\\/'),
						)}
					</script>
					<div id="cockpit-diffs">
					${rendered.map(
						(f) => html`<div class="file-label">${f.filename} <span class="muted">(${f.status})</span></div>
							${f.html
								? html`<div class="diffs-scope">${raw(f.html)}</div>`
								: html`<p class="muted">diff not rendered (binary, renamed, or too large)</p>`}`,
					)}
					</div>
					${prFiles.length > MAX_FILES
						? html`<p class="muted">…and ${prFiles.length - MAX_FILES} more files — see the PR on GitHub.</p>`
						: ''}
					<script type="module" src="/cockpit/app.js"></script>`,
			),
		);
	});

	// Line-anchored review comment from the cockpit diff. Submitting one
	// dispatches the fix agent against that exact finding — this replaces
	// GitHub review threads as the fix channel for factory PRs.
	app.post('/factory/features/:id/comments', async (c) => {
		const user = await requireUser(c);
		if (!user) return c.json({ error: 'unauthorized' }, 401);

		const id = Number(c.req.param('id'));
		const feature = Number.isInteger(id) ? await getFeature(id) : null;
		const repo = feature ? await getRepoById(feature.repository_id) : null;
		if (!feature || !repo || !user.installationIds.includes(repo.installation_id)) {
			return c.json({ error: 'unknown feature' }, 404);
		}
		const payload = await c.req
			.json<{ path?: string; line?: number; side?: string; body?: string }>()
			.catch(() => null);
		if (
			!payload?.path ||
			!Number.isInteger(payload.line) ||
			!payload.body?.trim() ||
			!feature.pr_number
		) {
			return c.json({ error: 'body must be {path, line, side?, body}' }, 400);
		}
		const side = payload.side === 'deletions' ? 'deletions' : 'additions';
		const commentId = await createCockpitComment(
			feature.id,
			payload.path,
			payload.line as number,
			side,
			payload.body.trim(),
			user.session.login,
		);
		// The comment IS the work order: dispatch the fixer with it verbatim.
		// The consumer re-validates the auto_fix toggle and the attempt cap.
		await env.FACTORY_QUEUE.send({
			kind: 'fix',
			repoId: repo.id,
			prNumber: feature.pr_number,
			trigger: 'cockpit_comment',
			findings:
				`**P1** — Reviewer comment on \`${payload.path}:${payload.line}\` ` +
				`(from @${user.session.login} in the Turbodiff cockpit):\n\n${payload.body.trim()}`,
		});
		await markCockpitCommentDispatched(commentId);
		return c.json({ ok: true, comment_id: commentId, fix_dispatched: true });
	});

	// Human-initiated merge from the cockpit. Deliberately does not reuse the
	// auto-merge gates: a signed-in repo admin clicking Merge IS the authority.
	app.post('/factory/features/:id/merge', async (c) => {
		const user = await requireUser(c);
		if (!user) return c.redirect('/auth/login');

		const id = Number(c.req.param('id'));
		const feature = Number.isInteger(id) ? await getFeature(id) : null;
		const repo = feature ? await getRepoById(feature.repository_id) : null;
		if (!feature || !repo || !user.installationIds.includes(repo.installation_id)) {
			return c.text('unknown feature', 404);
		}
		if (!feature.pr_number) return c.redirect(`/factory/features/${id}`);
		try {
			const token = await installationToken(repo.installation_id);
			await gh(token, `/repos/${repo.owner}/${repo.name}/pulls/${feature.pr_number}/merge`, {
				method: 'PUT',
				body: JSON.stringify({ merge_method: 'merge' }),
			});
		} catch (err) {
			console.error(`turbodiff: cockpit merge failed for feature ${id}:`, err);
		}
		return c.redirect(`/factory/features/${id}`);
	});

	return app;
}
