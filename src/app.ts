import { setProvider } from '@flue/runtime';
import { cloudflareBindingProvider } from '@flue/runtime/cloudflare/workers-ai';
import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { dispatchReviewAgent } from './ai/review/dispatch.ts';
import { registerReviewMetering } from './ai/review/metering.ts';
import { createApiRoutes } from './http/api.ts';
import { handleEmailSignUp } from './http/auth-email.ts';
import { renderCertificatePage } from './http/certificate-page.tsx';
import { createInternalRoutes } from './http/internal.ts';
import { createMcpRoutes } from './http/mcp.ts';
import { handleMcpProxy } from './http/mcp-proxy.ts';
import { createUiRoutes } from './http/ui.ts';
import { createWebhookRoutes } from './http/webhooks.ts';
import { oAuthDiscoveryMetadata, oAuthProtectedResourceMetadata } from 'better-auth/plugins';
import { auth } from './integrations/auth/better-auth.ts';
import { verifyArtifactSig } from './integrations/security/crypto.ts';
import { certificateSigKey, loadCertificateData } from './services/certificates.ts';

// Route every model call through the Workers AI binding and the named
// AI Gateway (set AI_GATEWAY_ID in wrangler.jsonc). The gateway holds the
// provider keys (BYOK) — no ANTHROPIC_API_KEY ever enters this Worker.
setProvider(
  cloudflareBindingProvider({
    binding: env.AI,
    gateway: { id: env.AI_GATEWAY_ID, metadata: { app: 'turbodiff' } },
  }),
);

// Accumulate per-turn token usage and cost onto review rows in D1.
registerReviewMetering();

const startedAt = Date.now();

const app = new Hono();

// Baseline security headers. Every HTML page — the cockpit shell above all —
// refuses framing: the Merge/Abandon buttons are session-authed clickjacking
// targets, and cookie SameSite rules do not gate framing. Script/style
// sources stay unrestricted (the shell uses inline styles and Google Fonts);
// frame-ancestors is the load-bearing directive here. nosniff goes on every
// response so uploaded artifacts are never content-sniffed into something
// executable.
app.use('*', async (c, next) => {
  await next();
  // Responses returned by the static-assets binding have immutable Headers.
  // Re-wrap the response once so security headers work for both Worker-owned
  // responses and hashed assets. A WebSocket upgrade must retain its native
  // response object and does not need document security headers.
  if (c.res.status === 101) return;
  const headers = new Headers(c.res.headers);
  headers.set('x-content-type-options', 'nosniff');
  if (headers.get('content-type')?.includes('text/html')) {
    headers.set(
      'content-security-policy',
      "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
    );
    headers.set('x-frame-options', 'DENY');
    headers.set('referrer-policy', 'same-origin');
  }
  c.res = new Response(c.res.body, {
    status: c.res.status,
    statusText: c.res.statusText,
    headers,
  });
});

app.get('/healthz', async (c) => {
  try {
    await env.DB.prepare('SELECT 1').run();
  } catch (err) {
    console.error('turbodiff: healthz D1 check failed', err);
    return c.json({ ok: false, db: false }, 503);
  }
  return c.json({ ok: true, db: true, uptime_s: Math.round((Date.now() - startedAt) / 1000) });
});

// Reports the live Worker version (Cloudflare Version Metadata binding) so
// deploy tooling can confirm which build is running. No auth, like /healthz.
app.get('/version', (c) => {
  return c.json({ id: env.CF_VERSION_METADATA.id, tag: env.CF_VERSION_METADATA.tag });
});

// Verification evidence (Phase 4): screenshots from verify runs, stored in R2
// and embedded in PR comments — public so GitHub can render them inline. Keys
// are harness-generated (verify/<featureId>/<name>.png), never user input.
app.get('/artifacts/*', async (c) => {
  const key = c.req.path.replace(/^\/artifacts\//, '');
  if (!key || key.includes('..')) return c.notFound();
  // Capability URL: the signature over the key (issued when the artifact was
  // uploaded) is the only credential — no signature, no object, and keys
  // cannot be enumerated.
  const sig = c.req.query('sig') ?? '';
  if (!(await verifyArtifactSig(key, sig))) return c.notFound();
  const object = await env.ARTIFACTS.get(key);
  if (!object) return c.notFound();
  return new Response(object.body, {
    headers: {
      'content-type': object.httpMetadata?.contentType ?? 'application/octet-stream',
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
});

// Shareable "Proof of Build" certificate for a factory feature: the latest
// verification evidence rendered as a public page. Same capability-URL scheme
// as /artifacts/* — the signature over cert/<id> is the only credential.
app.get('/b/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.notFound();
  const sig = c.req.query('sig') ?? '';
  if (!(await verifyArtifactSig(certificateSigKey(id), sig))) return c.notFound();
  const data = await loadCertificateData(id);
  if (!data) return c.notFound();
  return c.html(renderCertificatePage(data));
});

// GitHub App webhooks — authenticated by HMAC signature, not the bearer secret.
app.route('/webhooks', createWebhookRoutes(dispatchReviewAgent));

// MCP relay for sandbox runs — authenticated by a short-lived sealed grant
// minted per run, not by session or bearer secret (see lib/mcp-proxy.ts).
app.on(['GET', 'POST', 'DELETE'], '/mcp-proxy/:id', handleMcpProxy);

// Inbound MCP server (distinct from the /mcp-proxy/:id relay above — this is
// turbodiff exposing its own tools, OAuth-bearer authed via better-auth's
// mcp plugin). /mcp and /mcp-proxy/:id are distinct prefixes; no shadowing.
app.route('/mcp', createMcpRoutes());

// OAuth 2.1 discovery for MCP hosts (RFC 8414 / RFC 9728). The plugin's own
// authorize/token/register endpoints ride the /api/auth/* catch-all below;
// only the root-level .well-known documents need explicit mounts. Kept above
// the UI mount to preserve this file's ordering discipline, though
// createUiRoutes registers no competing GET.
app.get('/.well-known/oauth-authorization-server', (c) =>
  oAuthDiscoveryMetadata(auth())(c.req.raw),
);
app.get('/.well-known/oauth-protected-resource', (c) =>
  oAuthProtectedResourceMetadata(auth())(c.req.raw),
);

// better-auth (sessions, OAuth callback, sign-out). Registered before the
// /api data plane so it owns the /api/auth prefix.
//
// /update-user is closed: it's the only better-auth route that accepts user
// additionalFields as client input, and login/githubId can't be input:false
// (better-auth would strip them from the OAuth profile mapping — see
// better-auth.ts). Nothing in the app updates users; GitHub is the source
// of truth via overrideUserInfoOnSignIn.
app.on(['GET', 'POST'], '/api/auth/update-user', (c) => c.json({ error: 'not found' }, 404));

// Email/password sign-up goes through an allowlist rebuild of the body —
// login/githubId would otherwise be accepted as client input (see
// handleEmailSignUp).
app.post('/api/auth/sign-up/email', handleEmailSignUp);

app.on(['GET', 'POST'], '/api/auth/*', (c) => auth().handler(c.req.raw));

// SPA data plane (session cookie auth, JSON in/out).
app.route('/api', createApiRoutes());

// SPA shell + landing + OAuth sign-in (session cookie auth).
app.route('/', createUiRoutes());

app.route('/internal', createInternalRoutes());

export default app;
