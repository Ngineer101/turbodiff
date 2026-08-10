import { env } from 'cloudflare:workers';
import type { Context } from 'hono';
import { deleteCookie, getCookie } from 'hono/cookie';
import { fetchUserInstallationIds } from './github-app.ts';
import { openSession, SESSION_COOKIE, type Session } from './session.ts';

export type AuthedUser = { session: Session; installationIds: number[] };

// GitHub is the source of truth for which installations this user may manage;
// D1 only supplies Turbodiff's per-repo settings and usage. Returns null when
// the session is missing or the token expired (the cookie is cleared).
export async function requireUser(c: Context): Promise<AuthedUser | null> {
  // Local-only escape hatch for developing the signed-in UI without GitHub
  // OAuth: DEV_FAKE_INSTALLATIONS="1001,1002" in .dev.vars signs you in as
  // @dev with those installation ids. Guarded to loopback hosts so setting it
  // in production by mistake cannot become an auth bypass.
  const fake = (env as { DEV_FAKE_INSTALLATIONS?: string }).DEV_FAKE_INSTALLATIONS;
  const host = new URL(c.req.url).hostname;
  if (fake && (host === 'localhost' || host === '127.0.0.1')) {
    return {
      session: { userId: 0, login: 'dev', ghToken: '', exp: 0 },
      installationIds: fake
        .split(',')
        .map(Number)
        .filter((n) => Number.isInteger(n)),
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
