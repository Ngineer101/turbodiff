import { env } from 'cloudflare:workers';
import type { Context } from 'hono';
import { auth, type AuthUser } from './better-auth.ts';
import { fetchUserInstallationIds } from './github-app.ts';

// Request-time authorization on top of better-auth sessions. The session
// (who you are) is durable and only ends by explicit sign-out or 30-day
// expiry; GitHub is still the source of truth for which installations you
// may manage, but a failed GitHub call now degrades to the last known
// answer instead of destroying the session — the old behavior deleted the
// cookie on any /user/installations failure, which with the board's 5s
// polling signed users out on every rate-limit blip.

export type AuthedUser = {
  session: { userId: number; login: string; ghToken: string };
  installationIds: number[];
};

// Per-isolate caches. Entries are tiny (a token string / a handful of ids);
// isolate recycling is the eviction policy.
const TOKEN_TTL_MS = 10 * 60_000;
const INSTALLATIONS_TTL_MS = 5 * 60_000;
// How long a stale installation list may keep answering while GitHub is
// unreachable — bounds how long a revoked member could retain access.
const INSTALLATIONS_STALE_MAX_MS = 60 * 60_000;
const tokenCache = new Map<string, { token: string; exp: number }>();
const installationsCache = new Map<string, { ids: number[]; fetchedAt: number }>();

// A currently-valid GitHub user access token from the better-auth account
// row (refreshed + persisted by better-auth near expiry). Empty string when
// unavailable — callers treat that as "GitHub says no" on the calls they
// make with it, not as a reason to end the session.
async function githubToken(userId: string): Promise<string> {
  const cached = tokenCache.get(userId);
  if (cached && cached.exp > Date.now()) return cached.token;
  try {
    const { accessToken } = await auth().api.getAccessToken({
      body: { providerId: 'github', userId },
    });
    if (!accessToken) return '';
    tokenCache.set(userId, { token: accessToken, exp: Date.now() + TOKEN_TTL_MS });
    return accessToken;
  } catch {
    return '';
  }
}

// GitHub-verified installation ids, cached for 5 minutes and served stale
// (up to an hour) when GitHub is unreachable. Null only when there is no
// answer at all — fresh fetch failed and nothing usable is cached.
async function installationIds(userId: string, ghToken: string): Promise<number[] | null> {
  const cached = installationsCache.get(userId);
  if (cached && Date.now() - cached.fetchedAt < INSTALLATIONS_TTL_MS) return cached.ids;
  if (ghToken) {
    try {
      const ids = await fetchUserInstallationIds(ghToken);
      installationsCache.set(userId, { ids, fetchedAt: Date.now() });
      return ids;
    } catch {
      // fall through to the stale answer
    }
  }
  if (cached && Date.now() - cached.fetchedAt < INSTALLATIONS_STALE_MAX_MS) return cached.ids;
  return null;
}

export async function requireUser(c: Context): Promise<AuthedUser | null> {
  // Local-only escape hatch for developing the signed-in UI without GitHub
  // OAuth: DEV_FAKE_INSTALLATIONS="1001,1002" in .dev.vars signs you in as
  // @dev with those installation ids. Guarded to loopback hosts so setting it
  // in production by mistake cannot become an auth bypass.
  const fake = (env as { DEV_FAKE_INSTALLATIONS?: string }).DEV_FAKE_INSTALLATIONS;
  const host = new URL(c.req.url).hostname;
  if (fake && (host === 'localhost' || host === '127.0.0.1')) {
    return {
      session: { userId: 0, login: 'dev', ghToken: '' },
      installationIds: fake
        .split(',')
        .map(Number)
        .filter((n) => Number.isInteger(n)),
    };
  }
  const found = await auth().api.getSession({ headers: c.req.raw.headers });
  if (!found) return null;
  const user = found.user as AuthUser;
  // Pre-better-auth rows can't exist (the tables shipped together), so a
  // user without GitHub identity fields is malformed — treat as signed out.
  if (!user.login || typeof user.githubId !== 'number') return null;

  const ghToken = await githubToken(user.id);
  const ids = await installationIds(user.id, ghToken);
  if (ids === null) return null;
  return { session: { userId: user.githubId, login: user.login, ghToken }, installationIds: ids };
}
