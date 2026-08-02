import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { html } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import {
	listInstallationsWithRepos,
	listRecentReviews,
	getRepoById,
	setRepoEnabled,
	type ReviewActivityRow,
} from '../lib/db.ts';
import {
	exchangeOAuthCode,
	fetchUser,
	fetchUserInstallationIds,
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

// Settings UI: sign in with GitHub (the App's OAuth), see the installations
// you belong to, and toggle auto-review per repository. Repo *selection*
// happens in GitHub's own install flow; this page only holds Turbodiff config.

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
					href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&display=swap"
					rel="stylesheet"
				/>
				<style>
					:root { color-scheme: dark; }
					body {
						font: 14px/1.6 'IBM Plex Mono', ui-monospace, monospace;
						background: #070b09; color: #e6efe9;
						max-width: 720px; margin: 3rem auto; padding: 0 1rem;
					}
					h1 { font-size: 1.25rem; font-weight: 500; letter-spacing: 0.02em; }
					h2 { font-size: 0.95rem; font-weight: 500; margin-top: 2rem; color: #b8c4bc; }
					h2::before { content: '// '; color: #3fb950; }
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
					td { padding: 0.5rem 0.25rem; border-top: 1px solid #1c2620; }
					td:last-child { text-align: right; }
					.muted { color: #7d8f85; font-size: 0.85rem; }
					.pill { font-size: 0.75rem; padding: 0.1rem 0.55rem; border-radius: 999px; border: 1px solid #2a3830; color: #7d8f85; white-space: nowrap; }
					.pill.red { border-color: #f8514966; color: #f85149; }
					.pill.running { border-color: #3fb95066; color: #56d364; }
					.pill.running::before { content: '● '; animation: pulse 1.6s ease-in-out infinite; }
					@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
					.topbar { display: flex; justify-content: space-between; align-items: center; }
					form { display: inline; }
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

// A dispatch that never completed and is older than this is presumed dead
// (agent error before post_review) rather than still running.
const STALL_AFTER_MS = 20 * 60 * 1000;

function reviewState(r: ReviewActivityRow): 'running' | 'completed' | 'stalled' {
	if (r.status !== 'running') return 'completed';
	return Date.now() - parseUtc(r.created_at) > STALL_AFTER_MS ? 'stalled' : 'running';
}

function reviewRow(r: ReviewActivityRow) {
	const repoFull =
		r.repo_owner && r.repo_name ? `${r.repo_owner}/${r.repo_name}` : '(removed repository)';
	const prUrl =
		r.repo_owner && r.repo_name
			? `https://github.com/${r.repo_owner}/${r.repo_name}/pull/${r.pr_number}`
			: null;
	const state = reviewState(r);
	const duration =
		r.completed_at !== null
			? `${Math.max(1, Math.round((parseUtc(r.completed_at) - parseUtc(r.created_at)) / 1000))}s`
			: null;
	return html`<tr>
		<td>
			${prUrl ? html`<a href="${prUrl}">${repoFull}#${r.pr_number}</a>` : html`${repoFull}#${r.pr_number}`}
			<span class="muted">&middot; ${r.trigger_event} &middot; ${ago(r.created_at)}</span>
		</td>
		<td>
			${state === 'running'
				? html`<span class="pill running">reviewing</span>`
				: state === 'stalled'
					? html`<span class="pill red">stalled</span>`
					: r.review_url
						? html`<a href="${r.review_url}"><span class="pill">done${duration ? ` in ${duration}` : ''} &rarr;</span></a>`
						: html`<span class="pill">done${duration ? ` in ${duration}` : ''}</span>`}
		</td>
	</tr>`;
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

	app.get('/', async (c) => {
		const session = await openSession(getCookie(c, SESSION_COOKIE));
		if (!session) {
			return c.html(renderLanding(env.GITHUB_APP_SLUG));
		}

		// GitHub is the source of truth for which installations this user may
		// manage; D1 only supplies Turbodiff's per-repo settings.
		let installationIds: number[];
		try {
			installationIds = await fetchUserInstallationIds(session.ghToken);
		} catch {
			deleteCookie(c, SESSION_COOKIE, { path: '/' });
			return c.redirect('/auth/login');
		}
		const groups = await listInstallationsWithRepos(installationIds);

		return c.html(
			page(
				'Turbodiff — settings',
				html`<div class="topbar">
						<h1>Turbodiff settings</h1>
						<div>
							<span class="muted">@${session.login}</span>
							<form method="post" action="/auth/logout"><button class="secondary">Sign out</button></form>
						</div>
					</div>
					<p>
						<a class="button secondary" href="https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new">
							Add or manage repositories on GitHub
						</a>
						<a class="button secondary" href="/reviews">Review activity</a>
					</p>
					${groups.length === 0
						? html`<p class="muted">No installations yet — install the app on an organization or
								account, then come back here.</p>`
						: groups.map(
								({ installation, repos }) => html`<h2>
										${installation.account_login}
										${installation.suspended ? html`<span class="pill red">suspended</span>` : ''}
									</h2>
									<table>
										${repos.length === 0
											? html`<tr><td class="muted">No repositories selected in this installation.</td></tr>`
											: repos.map(
													(r) => html`<tr>
														<td>${r.owner}/${r.name}</td>
														<td>
															<form method="post" action="/repos/${r.id}/toggle">
																<button class="${r.enabled ? 'secondary' : ''}">
																	${r.enabled ? 'Disable reviews' : 'Enable reviews'}
																</button>
															</form>
														</td>
													</tr>`,
												)}
									</table>`,
							)}`,
			),
		);
	});

	app.get('/reviews', async (c) => {
		const session = await openSession(getCookie(c, SESSION_COOKIE));
		if (!session) return c.redirect('/auth/login');

		let installationIds: number[];
		try {
			installationIds = await fetchUserInstallationIds(session.ghToken);
		} catch {
			deleteCookie(c, SESSION_COOKIE, { path: '/' });
			return c.redirect('/auth/login');
		}
		const reviews = await listRecentReviews(installationIds);
		const anyRunning = reviews.some((r) => reviewState(r) === 'running');

		return c.html(
			page(
				'Turbodiff — review activity',
				html`<div class="topbar">
						<h1>Review activity</h1>
						<div>
							<span class="muted">@${session.login}</span>
							<form method="post" action="/auth/logout"><button class="secondary">Sign out</button></form>
						</div>
					</div>
					<p><a href="/">&larr; back to settings</a></p>
					${reviews.length === 0
						? html`<p class="muted">No reviews yet — open a pull request on an enabled repository
								and it will show up here.</p>`
						: html`<table>
								${reviews.map((r) => reviewRow(r))}
							</table>`}
					${anyRunning
						? html`<p class="muted">A review is running — this page refreshes every 10 seconds.</p>
								<script>
									setTimeout(function () { location.reload(); }, 10000);
								</script>`
						: ''}`,
			),
		);
	});

	app.post('/repos/:id/toggle', async (c) => {
		const session = await openSession(getCookie(c, SESSION_COOKIE));
		if (!session) return c.redirect('/auth/login');

		const repoId = Number(c.req.param('id'));
		const repo = Number.isInteger(repoId) ? await getRepoById(repoId) : null;
		if (!repo) return c.text('unknown repository', 404);

		const installationIds = await fetchUserInstallationIds(session.ghToken).catch(
			(): number[] => [],
		);
		if (!installationIds.includes(repo.installation_id)) {
			return c.text('you do not have access to this repository', 403);
		}

		await setRepoEnabled(repo.id, !repo.enabled);
		return c.redirect('/');
	});

	return app;
}
