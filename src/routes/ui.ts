import { env } from 'cloudflare:workers';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { exchangeOAuthCode, fetchUser, oauthAuthorizeUrl } from '../lib/github-app.ts';
import { storeUserCredential } from '../lib/user-tokens.ts';
import {
  openSession,
  randomToken,
  sealSession,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  type Session,
} from '../lib/session.ts';
import { renderLanding } from './landing.tsx';

// Signed-in UI: a TanStack Router SPA (src/client, built into public/app by
// vite.client.config.ts). This module only owns OAuth and serving the shell —
// all data flows through the JSON API in ./api.ts. Logged-out / serves the
// landing page.

const STATE_COOKIE = 'turbodiff_oauth_state';

// The shell references fixed asset names (no content hashes) so it can be a
// static string here; see build.rollupOptions in vite.client.config.ts.
const SHELL = `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>Turbodiff</title>
		<meta name="color-scheme" content="dark" />
		<link rel="icon" type="image/png" href="/logo-small.png" />
		<link rel="preconnect" href="https://fonts.googleapis.com" />
		<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
		<link
			href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;0,700;1,400&family=IBM+Plex+Mono:ital,wght@0,400;0,500;0,600;0,700;1,400&display=swap"
			rel="stylesheet"
		/>
		<link rel="stylesheet" href="/app/app.css" />
		<style>html { background: #070b09; }</style>
	</head>
	<body>
		<div id="root"></div>
		<script type="module" src="/app/app.js"></script>
	</body>
</html>`;

// Cheap shell gate: a valid, unexpired session cookie. Installation-level
// authorization happens per request in the API layer.
async function hasSession(c: Context): Promise<boolean> {
  const fake = (env as { DEV_FAKE_INSTALLATIONS?: string }).DEV_FAKE_INSTALLATIONS;
  const host = new URL(c.req.url).hostname;
  if (fake && (host === 'localhost' || host === '127.0.0.1')) return true;
  return (await openSession(getCookie(c, SESSION_COOKIE))) !== null;
}

export function createUiRoutes() {
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
    const tokens = await exchangeOAuthCode(code, redirectUri);
    const user = await fetchUser(tokens.token);
    // Durable credential for async attribution (user-opened PRs). Best
    // effort — sign-in never fails over it.
    await storeUserCredential(user.id, user.login, tokens).catch((err) =>
      console.warn('turbodiff: storing user refresh token failed:', err),
    );
    const session: Session = {
      userId: user.id,
      login: user.login,
      ghToken: tokens.token,
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
    if (!(await hasSession(c))) return c.html(renderLanding(env.GITHUB_APP_SLUG));
    return c.html(SHELL);
  });

  // Every SPA route the client router owns. Unauthenticated hits start OAuth,
  // matching the old server-rendered pages.
  for (const path of [
    '/tasks',
    '/tasks/*',
    '/usage',
    '/integrations',
    '/factory/*',
    '/agents',
    '/agents/*',
    '/settings',
  ]) {
    app.get(path, async (c) => {
      if (!(await hasSession(c))) return c.redirect('/auth/login');
      return c.html(SHELL);
    });
  }

  return app;
}
