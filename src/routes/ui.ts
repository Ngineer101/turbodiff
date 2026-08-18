import { env } from 'cloudflare:workers';
import { Hono, type Context } from 'hono';
import { deleteCookie } from 'hono/cookie';
import { auth } from '../lib/better-auth.ts';
import { renderLanding } from './landing.tsx';

// Signed-in UI: a TanStack Router SPA (src/client, built into public/app by
// vite.client.config.ts). This module only owns sign-in/out and serving the
// shell — sessions are better-auth's (src/lib/better-auth.ts), and all data
// flows through the JSON API in ./api.ts. Logged-out / serves the landing
// page.

// The pre-better-auth stateless session cookie — deleted on sign-out so
// nothing stale lingers after the migration.
const LEGACY_SESSION_COOKIE = 'turbodiff_session';

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
		<link rel="manifest" href="/manifest.webmanifest" />
		<link rel="apple-touch-icon" href="/logo.png" />
		<meta name="theme-color" content="#3fb950" />
		<link rel="preconnect" href="https://fonts.googleapis.com" />
		<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
		<link
			href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;0,700;1,400&family=IBM+Plex+Mono:ital,wght@0,400;0,500;0,600;0,700;1,400&display=swap"
			rel="stylesheet"
		/>
		<link rel="stylesheet" href="/app/app.css" />
		<style>html { background: #0f1318; }</style>
	</head>
	<body>
		<div id="root"></div>
		<script type="module" src="/app/app.js"></script>
	</body>
</html>`;

// Cheap shell gate: a live better-auth session (cookie-cached — no D1 read
// within the cache window). Installation-level authorization happens per
// request in the API layer.
async function hasSession(c: Context): Promise<boolean> {
  // SAFETY: DEV_FAKE_INSTALLATIONS comes from .dev.vars only, so `wrangler
  // types` omits it from Env wherever .dev.vars is absent (CI, production).
  const fake = (env as Env & { DEV_FAKE_INSTALLATIONS?: string }).DEV_FAKE_INSTALLATIONS;
  const host = new URL(c.req.url).hostname;
  if (fake && (host === 'localhost' || host === '127.0.0.1')) return true;
  return (await auth().api.getSession({ headers: c.req.raw.headers })) !== null;
}

export function createUiRoutes() {
  const app = new Hono();

  app.get('/auth/login', async (c) => {
    // Server-initiated better-auth social sign-in. The returned headers carry
    // the state cookie the OAuth callback validates — they must reach the
    // browser along with the redirect.
    const { headers, response } = await auth().api.signInSocial({
      body: { provider: 'github', callbackURL: '/' },
      returnHeaders: true,
    });
    if (!response.url) return c.text('sign-in failed — start again at /', 502);
    const res = c.redirect(response.url);
    for (const cookie of headers.getSetCookie()) res.headers.append('set-cookie', cookie);
    return res;
  });

  // GitHub still redirects to the App-registered /auth/callback; hand the
  // request to better-auth's github callback route unchanged (query intact),
  // so the GitHub App needs no callback-URL change.
  app.get('/auth/callback', (c) => {
    const url = new URL(c.req.url);
    url.pathname = '/api/auth/callback/github';
    return auth().handler(new Request(url, c.req.raw));
  });

  app.post('/auth/logout', async (c) => {
    deleteCookie(c, LEGACY_SESSION_COOKIE, { path: '/' });
    let cookies: string[] = [];
    try {
      const { headers } = await auth().api.signOut({
        headers: c.req.raw.headers,
        returnHeaders: true,
      });
      cookies = headers.getSetCookie();
    } catch {
      // No live session to revoke — still land signed out on /.
    }
    const res = c.redirect('/');
    for (const cookie of cookies) res.headers.append('set-cookie', cookie);
    return res;
  });

  app.get('/', async (c) => {
    if (!(await hasSession(c))) return c.html(renderLanding());
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
