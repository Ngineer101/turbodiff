import type { Context } from 'hono';
import { withAuth } from '../integrations/auth/better-auth.ts';
import type { JsonObject } from '../shared/json.ts';

// HTTP email/password sign-up accepts user additionalFields as client input for
// the same reason /update-user is closed (login/githubId can't be
// input:false — better-auth would strip them from the OAuth profile mapping,
// see better-auth.ts), so the body is rebuilt from an allowlist here —
// otherwise a sign-up could forge a GitHub identity and requireUser would
// trust it.
export async function handleEmailSignUp(c: Context): Promise<Response> {
  const body = await c.req.json<JsonObject>().catch(() => null);
  if (!body) return c.json({ error: 'invalid body' }, 400);
  const { name, email, password, callbackURL, rememberMe } = body;
  const headers = new Headers(c.req.raw.headers);
  headers.delete('content-length');
  return withAuth((instance) =>
    instance.handler(
      new Request(c.req.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name, email, password, callbackURL, rememberMe }),
      }),
    ),
  );
}
