import { env } from 'cloudflare:workers';
import { database } from '../data/postgres.ts';
import { auth, type AuthUser } from '../integrations/auth/better-auth.ts';
import {
  installationAccessSnapshot,
  storeInstallationAccessSnapshot,
} from '../data/performance.ts';
import { syntheticInstallationIds } from './access-control.ts';
import {
  fetchUserCanPush,
  fetchUserInstallationIds,
  fetchUserOrgRole,
} from '../integrations/github/app.ts';
import { isNumber, isString } from '../shared/json.ts';

// Application authorization on top of better-auth sessions. The session
// (who you are) is durable and only ends by explicit sign-out or 30-day
// expiry; GitHub is still the source of truth for which installations you
// may manage, but a failed GitHub call now degrades to the last known
// answer instead of destroying the session — the old behavior deleted the
// cookie on any /user/installations failure, which with the board's 5s
// polling signed users out on every rate-limit blip.

export type AuthedUser = {
  // GitHub identity. For a password sign-up that hasn't linked GitHub yet,
  // userId is 0 and login/ghToken are empty — installationIds is [] so every
  // repo-scoped query answers empty and every push check fails closed; the
  // attribution paths that read userId/login all sit behind an installation
  // check a GitHub-less user can't pass.
  session: { authUserId: string; userId: number; login: string };
  installationIds: number[];
  githubConnected: boolean;
  // Display identity for the shell — the GitHub login when connected, the
  // sign-up name otherwise.
  name: string;
  // A stale-but-authorized request may refresh its durable membership
  // snapshot after responding. HTTP middleware attaches this to waitUntil;
  // non-HTTP callers simply use the bounded stale snapshot.
  membershipRefresh?: () => Promise<void>;
  // Local DEV_FAKE_INSTALLATIONS session — no GitHub token to verify repo
  // permissions with, so permission checks pass by construction.
  devFake?: boolean;
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
const installationRefreshes = new Map<string, Promise<number[] | null>>();
// Synthetic (Artifacts) installation ids were the one uncached PostgreSQL read on
// every API request — same TTL discipline as the GitHub installation list,
// with the same bounded staleness on membership revocation.
const SYNTHETIC_TTL_MS = 60_000;
const syntheticCache = new Map<number, { ids: number[]; fetchedAt: number }>();

async function cachedSyntheticInstallationIds(githubId: number): Promise<number[]> {
  const cached = syntheticCache.get(githubId);
  if (cached && Date.now() - cached.fetchedAt < SYNTHETIC_TTL_MS) return cached.ids;
  const ids = await syntheticInstallationIds(githubId);
  syntheticCache.set(githubId, { ids, fetchedAt: Date.now() });
  return ids;
}

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
async function refreshInstallationIds(userId: string): Promise<number[] | null> {
  const running = installationRefreshes.get(userId);
  if (running) return running;
  const refresh = (async () => {
    const ghToken = await githubToken(userId);
    if (!ghToken) return null;
    try {
      const ids = await fetchUserInstallationIds(ghToken);
      await storeInstallationAccessSnapshot(userId, ids);
      installationsCache.set(userId, { ids, fetchedAt: Date.now() });
      return ids;
    } catch {
      return null;
    }
  })();
  installationRefreshes.set(userId, refresh);
  try {
    return await refresh;
  } finally {
    if (installationRefreshes.get(userId) === refresh) installationRefreshes.delete(userId);
  }
}

interface InstallationResolution {
  ids: number[];
  refresh?: () => Promise<void>;
}

async function installationIds(userId: string): Promise<InstallationResolution | null> {
  const cached = installationsCache.get(userId);
  if (cached && Date.now() - cached.fetchedAt < INSTALLATIONS_TTL_MS) {
    return { ids: cached.ids };
  }

  const durable = await installationAccessSnapshot(userId);
  const now = Date.now();
  if (durable) {
    installationsCache.set(userId, {
      ids: durable.installationIds,
      fetchedAt: durable.verifiedAt,
    });
    const age = now - durable.verifiedAt;
    if (age < INSTALLATIONS_TTL_MS) return { ids: durable.installationIds };
    if (age < INSTALLATIONS_STALE_MAX_MS) {
      return {
        ids: durable.installationIds,
        refresh: async () => {
          await refreshInstallationIds(userId);
        },
      };
    }
  }

  const fresh = await refreshInstallationIds(userId);
  if (fresh) return { ids: fresh };
  if (cached && now - cached.fetchedAt < INSTALLATIONS_STALE_MAX_MS) {
    return { ids: cached.ids };
  }
  return null;
}

export async function githubTokenForUser(user: AuthedUser): Promise<string> {
  if (user.devFake || !user.session.authUserId) return '';
  return githubToken(user.session.authUserId);
}

// Whether GitHub says this user can push to the repo, checked with the
// user's own token (GET /repos/:owner/:repo reports the caller's
// permissions). Installation membership alone is NOT write permission —
// GitHub lists an org installation for members with read-only access to any
// covered repo — so routes that write to a repo or change its factory
// posture must pass this too. Fail-closed: no token or a failed GitHub call
// denies. These checks guard explicit clicks, not the 5s polling reads, so
// a rare rate-limit blip surfaces as a retryable 403 rather than becoming a
// lingering grant.
const REPO_PERM_TTL_MS = 5 * 60_000;
const repoPermCache = new Map<string, { push: boolean; fetchedAt: number }>();

export async function userCanPushToRepo(
  user: AuthedUser,
  owner: string,
  name: string,
): Promise<boolean> {
  if (user.devFake) return true;
  const { userId } = user.session;
  const ghToken = await githubTokenForUser(user);
  if (!ghToken) return false;
  const key = `${userId}:${owner}/${name}`;
  const cached = repoPermCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < REPO_PERM_TTL_MS) return cached.push;
  try {
    const push = await fetchUserCanPush(ghToken, owner, name);
    repoPermCache.set(key, { push, fetchedAt: Date.now() });
    return push;
  } catch {
    return false;
  }
}

const ORG_ROLE_TTL_MS = 5 * 60_000;
const orgAdminCache = new Map<string, { admin: boolean; fetchedAt: number }>();

// Whether GitHub says this user is an admin (owner) of the organization,
// checked with their own token. Fail-closed: no token or a failed GitHub
// call (including a missing App org-members permission) answers false.
export async function userIsGithubOrgAdmin(user: AuthedUser, orgLogin: string): Promise<boolean> {
  if (user.devFake) return true;
  const { userId } = user.session;
  const ghToken = await githubTokenForUser(user);
  if (!ghToken) return false;
  const key = `${userId}:${orgLogin}`;
  const cached = orgAdminCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < ORG_ROLE_TTL_MS) return cached.admin;
  try {
    const admin = (await fetchUserOrgRole(ghToken, orgLogin)) === 'admin';
    orgAdminCache.set(key, { admin, fetchedAt: Date.now() });
    return admin;
  } catch (err) {
    console.warn(`turbodiff: org membership check failed for ${orgLogin}:`, err);
    return false;
  }
}

export async function requireUser(request: Request): Promise<AuthedUser | null> {
  // Local-only escape hatch for developing the signed-in UI without GitHub
  // OAuth: DEV_FAKE_INSTALLATIONS="1001,1002" in .dev.vars signs you in as
  // @dev with those installation ids. Guarded to loopback hosts so setting it
  // in production by mistake cannot become an auth bypass.
  // SAFETY: DEV_FAKE_INSTALLATIONS comes from .dev.vars only, so `wrangler
  // types` omits it from Env wherever .dev.vars is absent (CI, production).
  const fake = (env as Env & { DEV_FAKE_INSTALLATIONS?: string }).DEV_FAKE_INSTALLATIONS;
  const host = new URL(request.url).hostname;
  if (fake && (host === 'localhost' || host === '127.0.0.1')) {
    return {
      session: { authUserId: '', userId: 0, login: 'dev' },
      installationIds: fake
        .split(',')
        .map(Number)
        .filter((n) => Number.isInteger(n)),
      githubConnected: true,
      name: 'dev',
      devFake: true,
    };
  }
  const found = await auth().api.getSession({ headers: request.headers });
  if (!found) return null;
  const user = found.user;
  // better-auth's static session type erases the login/githubId
  // additionalFields, so narrow them through guards.
  const login = 'login' in user && isString(user.login) && user.login ? user.login : null;
  const githubId = 'githubId' in user && isNumber(user.githubId) ? user.githubId : null;
  return resolveAuthedUser({ id: user.id, name: user.name, email: user.email, login, githubId });
}

// Application authorization for an identified better-auth user — the single
// path shared by the cookie session (requireUser) and the /mcp OAuth bearer
// token (requireMcpUser), so installation scoping can never drift between
// the two transports.
async function resolveAuthedUser(user: AuthUser): Promise<AuthedUser | null> {
  const login = user.login ?? null;
  const githubId = user.githubId ?? null;
  // Email/password sign-up that hasn't linked a GitHub account yet: a valid
  // session with no GitHub reach — empty installations, everything
  // repo-scoped answers empty, push checks fail closed.
  if (!login || githubId === null) {
    return {
      session: { authUserId: user.id, userId: 0, login: '' },
      installationIds: [],
      githubConnected: false,
      name: user.name || user.email,
    };
  }

  const [resolved, synthetic] = await Promise.all([
    installationIds(user.id),
    cachedSyntheticInstallationIds(githubId),
  ]);
  if (resolved === null) return null;
  // GitHub cannot know about Artifacts-hosted projects, so membership-derived
  // installation ids are unioned in.
  return {
    session: { authUserId: user.id, userId: githubId, login },
    installationIds: [...new Set([...resolved.ids, ...synthetic])],
    githubConnected: true,
    name: login,
    membershipRefresh: resolved.refresh,
  };
}

// The /mcp bearer counterpart to requireUser: resolves an OAuth 2.1 access
// token issued by the better-auth MCP plugin
// to the same AuthedUser shape, through the same resolveAuthedUser tail —
// per-isolate token/installation caches and the synthetic-installation union
// included, so there is no second authorization path to keep in sync. Null
// for an absent, unknown, or expired token. The user row is read with a
// direct PostgreSQL query (precedent: services/access-control.ts queries better-auth
// tables directly).
export async function requireMcpUser(request: Request): Promise<AuthedUser | null> {
  const session = await auth().api.getMcpSession({ headers: request.headers });
  if (!session?.userId) return null;
  const row = await database()
    .prepare('SELECT "id", "name", "email", "login", "githubId" FROM "user" WHERE "id" = ?1')
    .bind(session.userId)
    .first<{
      id: string;
      name: string;
      email: string;
      login: string | null;
      githubId: number | null;
    }>();
  if (!row) return null;
  return resolveAuthedUser(row);
}
