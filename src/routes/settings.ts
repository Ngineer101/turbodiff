import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { html } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import { listInstallationsWithRepos, getRepoById, setRepoEnabled } from '../lib/db.ts';
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
				<style>
					:root { color-scheme: light dark; }
					body { font: 16px/1.5 system-ui, sans-serif; max-width: 720px; margin: 3rem auto; padding: 0 1rem; }
					h1 { font-size: 1.5rem; } h2 { font-size: 1.1rem; margin-top: 2rem; }
					a.button, button { display: inline-block; padding: 0.4rem 0.9rem; border-radius: 6px; border: 1px solid #8884; background: #2da44e; color: #fff; text-decoration: none; font-size: 0.95rem; cursor: pointer; }
					a.button.secondary, button.secondary { background: transparent; color: inherit; }
					table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; }
					td { padding: 0.45rem 0.25rem; border-top: 1px solid #8883; }
					td:last-child { text-align: right; }
					.muted { opacity: 0.65; font-size: 0.9rem; }
					.pill { font-size: 0.8rem; padding: 0.1rem 0.5rem; border-radius: 999px; border: 1px solid #8886; }
					.topbar { display: flex; justify-content: space-between; align-items: center; }
					form { display: inline; }
				</style>
			</head>
			<body>${body}</body>
		</html>`;
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
			return c.html(
				page(
					'Turbodiff',
					html`<h1>Turbodiff 🤖</h1>
						<p>Automatic AI code review for your pull requests. Install the GitHub App, pick your
						repositories, and every new PR gets an inline review.</p>
						<p>
							<a class="button" href="/auth/login">Sign in with GitHub</a>
							<a class="button secondary" href="https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new">Install the app</a>
						</p>`,
				),
			);
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
					</p>
					${groups.length === 0
						? html`<p class="muted">No installations yet — install the app on an organization or
								account, then come back here.</p>`
						: groups.map(
								({ installation, repos }) => html`<h2>
										${installation.account_login}
										${installation.suspended ? html`<span class="pill">suspended</span>` : ''}
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
