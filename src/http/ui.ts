import { env } from 'cloudflare:workers';
import { Hono, type Context } from 'hono';
import { deleteCookie } from 'hono/cookie';
import { withAuth } from '../integrations/auth/better-auth.ts';
import { isJsonArray, isJsonObject, isString, parseJson } from '../shared/json.ts';
import { renderAuthPage } from './auth-page.tsx';
import { renderLanding } from './landing.tsx';

// Signed-in HTTP UI: a TanStack Router SPA (src/client, built into public/app by
// vite.client.config.ts). This module only owns sign-in/out and serving the
// shell — sessions are better-auth's (src/integrations/auth/better-auth.ts), and all data
// flows through the JSON API in ./api.ts. Logged-out / serves the landing
// page.

// The pre-better-auth stateless session cookie — deleted on sign-out so
// nothing stale lingers after the migration.
const LEGACY_SESSION_COOKIE = 'turbodiff_session';

interface ClientAsset {
  file: string;
  css: string[];
  imports: string[];
  isEntry: boolean;
}

type ClientManifest = Map<string, ClientAsset>;
let manifestPromise: Promise<ClientManifest> | null = null;

function clientManifest(value: ReturnType<typeof parseJson>): ClientManifest {
  if (!isJsonObject(value)) throw new Error('client asset manifest is not an object');
  const manifest = new Map<string, ClientAsset>();
  for (const [key, raw] of Object.entries(value)) {
    if (!isJsonObject(raw) || !isString(raw.file)) continue;
    manifest.set(key, {
      file: raw.file,
      css: isJsonArray(raw.css) ? raw.css.filter(isString) : [],
      imports: isJsonArray(raw.imports) ? raw.imports.filter(isString) : [],
      isEntry: raw.isEntry === true,
    });
  }
  return manifest;
}

async function loadClientManifest(c: Context): Promise<ClientManifest> {
  // Static assets and Worker code deploy atomically, so one parsed manifest
  // is valid for this isolate's lifetime. Share the in-flight read too: a
  // burst of cold shell requests should parse the 200KB manifest once.
  manifestPromise ??= (async () => {
    const url = new URL('/app/manifest.json', c.req.url);
    const response = await env.ASSETS.fetch(url);
    if (!response.ok) throw new Error(`client asset manifest returned ${response.status}`);
    return clientManifest(parseJson(await response.text()));
  })();
  try {
    return await manifestPromise;
  } catch (err) {
    manifestPromise = null;
    throw err;
  }
}

function manifestAsset(manifest: ClientManifest, suffix: string): string | null {
  const hit = [...manifest].find(([key]) => key.endsWith(suffix));
  return hit?.[0] ?? null;
}

function routeAsset(path: string): string | null {
  if (path === '/') return 'src/client/pages/board.tsx';
  if (/^\/tasks\/\d+$/.test(path)) return 'src/client/pages/task.tsx';
  if (/^\/factory\/features\/\d+$/.test(path)) return 'src/client/pages/feature.tsx';
  if (/^\/repos\/\d+\/code(?:\/.*)?$/.test(path)) return 'src/client/pages/code.tsx';
  if (path === '/usage') return 'src/client/pages/usage.tsx';
  if (path === '/integrations') return 'src/client/pages/integrations.tsx';
  if (path === '/agents') return 'src/client/pages/agents.tsx';
  if (path === '/skills') return 'src/client/pages/skills.tsx';
  if (path === '/automations') return 'src/client/pages/automations.tsx';
  if (path === '/settings') return 'src/client/pages/settings.tsx';
  if (path === '/onboarding') return 'src/client/pages/onboarding.tsx';
  return null;
}

function clientAssets(manifest: ClientManifest, path: string) {
  const entryKey = [...manifest].find(([, asset]) => asset.isEntry)?.[0];
  if (!entryKey) throw new Error('client asset manifest has no entry');
  const routeSuffix = routeAsset(path);
  const routeKey = routeSuffix ? manifestAsset(manifest, routeSuffix) : null;
  const pending = [entryKey, ...(routeKey ? [routeKey] : [])];
  const visited = new Set<string>();
  const scripts = new Set<string>();
  const styles = new Set<string>();
  while (pending.length > 0) {
    const key = pending.pop();
    if (!key || visited.has(key)) continue;
    visited.add(key);
    const asset = manifest.get(key);
    if (!asset) continue;
    scripts.add(`/app/${asset.file}`);
    for (const css of asset.css) styles.add(`/app/${css}`);
    pending.push(...asset.imports);
  }
  const entry = manifest.get(entryKey);
  if (!entry) throw new Error('client asset manifest entry is missing');
  return { entry: `/app/${entry.file}`, scripts: [...scripts], styles: [...styles] };
}

// Boot-critical resources are declared up front: fonts are self-hosted,
// Vite's content-hashed entry and active route chunks are modulepreloaded,
// and the route's API payload overlaps JS parse instead of following it.
function shell(preload: string[], assets: ReturnType<typeof clientAssets>): string {
  return `<!doctype html>
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
${assets.scripts.map((path) => `\t\t<link rel="modulepreload" href="${path}" />`).join('\n')}
		<link rel="preload" href="/fonts/ibm-plex-sans-normal-400-latin.woff2" as="font" type="font/woff2" crossorigin />
		<link rel="preload" href="/fonts/ibm-plex-mono-normal-400-latin.woff2" as="font" type="font/woff2" crossorigin />
${preload.map((path) => `\t\t<link rel="preload" href="${path}" as="fetch" />`).join('\n')}
		<link rel="stylesheet" href="/fonts/fonts.css" />
${assets.styles.map((path) => `\t\t<link rel="stylesheet" href="${path}" />`).join('\n')}
		<style>
			html { background: #0f1318; }
			/* Static splash inside #root, painted before app.js runs; React's
			   first render (the router's pending Splash, visually identical)
			   replaces it, so PWA launches don't flash an empty page. */
			#splash {
				position: fixed;
				inset: 0;
				display: flex;
				flex-direction: column;
				align-items: center;
				justify-content: center;
				gap: 1rem;
				background: #0f1318;
				color: #8595a4;
				font-family: 'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', sans-serif;
			}
			#splash img { border-radius: 8px; }
			#splash .cursor { color: #56d364; animation: splash-blink 1.1s step-end infinite; }
			@keyframes splash-blink { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
			@media (prefers-reduced-motion: reduce) { #splash .cursor { animation: none; } }
		</style>
	</head>
	<body>
		<div id="root">
			<div id="splash" role="status">
				<img src="/logo-small.png" alt="Turbodiff" width="56" height="56" />
				<span>Loading<span class="cursor">_</span></span>
			</div>
		</div>
		<script type="module" src="${assets.entry}"></script>
	</body>
</html>`;
}

// Which API payload each SPA route needs first — preloaded from the shell so
// the browser has the response (or most of it) by the time app.js asks.
// /api/me rides on every shell; per-route payloads keep the preload honest.
async function shellForPath(c: Context, path: string): Promise<string> {
  const preload = ['/api/me'];
  if (path === '/') preload.push('/api/board');
  else if (path === '/settings') preload.push('/api/settings');
  else if (path === '/usage') preload.push('/api/usage');
  else if (path === '/integrations') preload.push('/api/integrations');
  else if (path === '/agents') preload.push('/api/agents');
  else if (path === '/skills') preload.push('/api/skills');
  else if (path === '/automations') preload.push('/api/automations');
  else if (/^\/tasks\/\d+$/.test(path)) preload.push(`/api${path}`);
  else if (/^\/factory\/features\/\d+$/.test(path)) preload.push(`/api${path}`);
  else {
    const code = path.match(/^\/repos\/(\d+)\/code(?:\/.*)?$/);
    if (code) preload.push(`/api/repos/${code[1]}/code`);
  }
  return shell(preload, clientAssets(await loadClientManifest(c), path));
}

// Cheap shell gate: a live better-auth session (cookie-cached — no PostgreSQL read
// within the cache window). Installation-level authorization happens per
// request in the API layer.
async function hasSession(c: Context): Promise<boolean> {
  // SAFETY: DEV_FAKE_INSTALLATIONS comes from .dev.vars only, so `wrangler
  // types` omits it from Env wherever .dev.vars is absent (CI, production).
  const fake = (env as Env & { DEV_FAKE_INSTALLATIONS?: string }).DEV_FAKE_INSTALLATIONS;
  const host = new URL(c.req.url).hostname;
  if (fake && (host === 'localhost' || host === '127.0.0.1')) return true;
  return (
    (await withAuth((instance) => instance.api.getSession({ headers: c.req.raw.headers }))) !== null
  );
}

export function createUiRoutes() {
  const app = new Hono();

  // Method chooser: GitHub OAuth or email/password (sign in / create
  // account). The forms post JSON to better-auth's /api/auth/sign-in/email
  // and /api/auth/sign-up/email from a small inline script.
  app.get('/auth/login', async (c) => {
    // OAuth continuation: better-auth's mcp plugin redirects an
    // unauthenticated /api/auth/mcp/authorize hit here with the authorize
    // query intact. After sign-in the browser must resume that authorize
    // request (which then redirects back to the MCP client with a code) —
    // landing on / would strand the client's OAuth flow.
    const query = new URL(c.req.url).searchParams;
    const oauthAuthorize = query.has('client_id') && query.has('redirect_uri');
    const renewSession = query.get('expired') === '1';
    const next = oauthAuthorize ? `/api/auth/mcp/authorize?${query.toString()}` : '/';
    // An API 401 can arrive while a cookie-cached shell session still exists.
    // Do not redirect that recovery request back to the dashboard.
    if (!renewSession && (await hasSession(c))) return c.redirect(next);
    return c.html(
      renderAuthPage(
        oauthAuthorize ? next : undefined,
        renewSession
          ? 'Your Turbodiff session needs to be renewed. Sign in to continue.'
          : undefined,
      ),
    );
  });

  app.get('/auth/login/github', async (c) => {
    // Where to land after sign-in; path-only so the redirect can't leave the
    // app (same idiom as /auth/connect/github). The OAuth authorize
    // continuation from /auth/login rides this as ?next=.
    const next = c.req.query('next') ?? '';
    const callbackURL = next.startsWith('/') && !next.startsWith('//') ? next : '/';
    // Server-initiated better-auth social sign-in. The returned headers carry
    // the state cookie the OAuth callback validates — they must reach the
    // browser along with the redirect.
    const { headers, response } = await withAuth((instance) =>
      instance.api.signInSocial({
        body: { provider: 'github', callbackURL },
        returnHeaders: true,
      }),
    );
    if (!response.url) return c.text('sign-in failed — start again at /', 502);
    const res = c.redirect(response.url);
    for (const cookie of headers.getSetCookie()) res.headers.append('set-cookie', cookie);
    return res;
  });

  // Link a GitHub account onto the signed-in (password) user — the
  // onboarding "Connect GitHub" button. Same OAuth callback as sign-in; the
  // state cookie marks it as a link request, and better-auth attaches the
  // github account row to this user instead of creating one.
  app.get('/auth/connect/github', async (c) => {
    if (!(await hasSession(c))) return c.redirect('/auth/login');
    // Where to land after the link completes; path-only so the redirect
    // can't leave the app.
    const next = c.req.query('next') ?? '';
    const callbackURL = next.startsWith('/') && !next.startsWith('//') ? next : '/onboarding';
    try {
      const { headers, response } = await withAuth((instance) =>
        instance.api.linkSocialAccount({
          body: {
            provider: 'github',
            callbackURL,
            errorCallbackURL: '/onboarding?error=link_failed',
          },
          headers: c.req.raw.headers,
          returnHeaders: true,
        }),
      );
      if (!response.url) return c.text('connect failed — start again at /onboarding', 502);
      const res = c.redirect(response.url);
      for (const cookie of headers.getSetCookie()) res.headers.append('set-cookie', cookie);
      return res;
    } catch {
      return c.redirect('/onboarding?error=link_failed');
    }
  });

  // GitHub still redirects to the App-registered /auth/callback; hand the
  // request to better-auth's github callback route unchanged (query intact),
  // so the GitHub App needs no callback-URL change.
  app.get('/auth/callback', (c) => {
    const url = new URL(c.req.url);
    url.pathname = '/api/auth/callback/github';
    return withAuth((instance) => instance.handler(new Request(url, c.req.raw)));
  });

  app.post('/auth/logout', async (c) => {
    deleteCookie(c, LEGACY_SESSION_COOKIE, { path: '/' });
    let cookies: string[] = [];
    try {
      const { headers } = await withAuth((instance) =>
        instance.api.signOut({
          headers: c.req.raw.headers,
          returnHeaders: true,
        }),
      );
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
    return c.html(await shellForPath(c, '/'));
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
    '/skills',
    '/skills/*',
    '/automations',
    '/automations/*',
    '/repos',
    '/repos/*',
    '/settings',
    '/settings/*',
    // Retired hub page — the client router redirects it to /settings.
    '/config',
    '/onboarding',
  ]) {
    app.get(path, async (c) => {
      if (!(await hasSession(c))) return c.redirect('/auth/login');
      return c.html(await shellForPath(c, new URL(c.req.url).pathname));
    });
  }

  return app;
}
