import { env } from 'cloudflare:workers';
import { sql } from 'drizzle-orm';
import { queryOne } from '../data/database.ts';
import { ensureBuiltinAgents } from '../data/db.ts';
import { withAuth, type AuthUser } from '../integrations/auth/better-auth.ts';
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
import { GitHubApiError } from '../integrations/github/client.ts';
import { isNumber, isString } from '../shared/json.ts';
import { syncInstallationRepos } from './repository-sync.ts';

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
  githubStatus: GitHubStatus;
  // Display identity for the shell — the GitHub login when connected, the
  // sign-up name otherwise.
  name: string;
  // A stale-but-authorized request may refresh its durable membership
  // snapshot after responding. HTTP middleware attaches this to waitUntil;
  // non-HTTP callers simply use the bounded stale snapshot.
  membershipRefresh?: () => Promise<void>;
  // A fresh GitHub membership answer may be the first one since a database
  // migration. Rebuild the recoverable installation/repository mirror after
  // the response; historical factory records remain a separate migration.
  repositoryRepair?: () => Promise<void>;
  // Local DEV_FAKE_INSTALLATIONS session — no GitHub token to verify repo
  // permissions with, so permission checks pass by construction.
  devFake?: boolean;
};

export type GitHubStatus =
  | 'not_connected'
  | 'reauthorization_required'
  | 'temporarily_unavailable'
  | 'app_not_installed'
  | 'syncing'
  | 'ready';

// Per-isolate caches. Entries are tiny (a token string / a handful of ids);
// isolate recycling is the eviction policy.
const TOKEN_TTL_MS = 10 * 60_000;
const INSTALLATIONS_TTL_MS = 5 * 60_000;
// How long a stale installation list may keep answering while GitHub is
// unreachable — bounds how long a revoked member could retain access.
const INSTALLATIONS_STALE_MAX_MS = 60 * 60_000;
const tokenCache = new Map<string, { token: string; exp: number }>();
const installationsCache = new Map<string, { ids: number[]; fetchedAt: number }>();
const repositoryRepairs = new Map<string, Promise<void>>();
type InstallationRefresh =
  | { kind: 'success'; ids: number[] }
  | { kind: 'reauthorization_required' }
  | { kind: 'temporarily_unavailable' };

const installationRefreshes = new Map<string, Promise<InstallationRefresh>>();
const githubAccessIssues = new Map<
  string,
  'reauthorization_required' | 'temporarily_unavailable'
>();
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
    const { accessToken } = await withAuth((instance) =>
      instance.api.getAccessToken({
        body: { providerId: 'github', userId },
      }),
    );
    if (!accessToken) return '';
    tokenCache.set(userId, { token: accessToken, exp: Date.now() + TOKEN_TTL_MS });
    return accessToken;
  } catch {
    return '';
  }
}

// GitHub-verified installation ids, cached for 5 minutes and served stale
// (up to an hour) when GitHub is unreachable. Without a usable snapshot, the
// result preserves whether the user should retry or re-authorize.
async function refreshInstallationIds(userId: string): Promise<InstallationRefresh> {
  const running = installationRefreshes.get(userId);
  if (running) return running;
  const refresh = (async () => {
    const ghToken = await githubToken(userId);
    if (!ghToken) {
      githubAccessIssues.set(userId, 'reauthorization_required');
      return { kind: 'reauthorization_required' } as const;
    }
    try {
      const ids = await fetchUserInstallationIds(ghToken);
      await storeInstallationAccessSnapshot(userId, ids);
      installationsCache.set(userId, { ids, fetchedAt: Date.now() });
      githubAccessIssues.delete(userId);
      return { kind: 'success', ids } as const;
    } catch (err) {
      // Never keep retrying a rejected credential from isolate memory. A
      // successful relink updates PostgreSQL; the next request must read it.
      tokenCache.delete(userId);
      if (err instanceof GitHubApiError && err.status === 401) {
        githubAccessIssues.set(userId, 'reauthorization_required');
        return { kind: 'reauthorization_required' } as const;
      }
      githubAccessIssues.set(userId, 'temporarily_unavailable');
      console.warn('turbodiff: GitHub installation membership is temporarily unavailable', err);
      return { kind: 'temporarily_unavailable' } as const;
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
  kind: 'success';
  ids: number[];
  refresh?: () => Promise<void>;
  repair?: () => Promise<void>;
}

type InstallationResult =
  | InstallationResolution
  | { kind: 'reauthorization_required' | 'temporarily_unavailable' };

async function repairRepositoryMirror(userId: string, installationIds: number[]): Promise<void> {
  const running = repositoryRepairs.get(userId);
  if (running) return running;
  const repair = Promise.all(
    installationIds.map((installationId) =>
      syncInstallationRepos(installationId)
        .then(() => ensureBuiltinAgents(installationId))
        .catch((err) => {
          console.warn(
            `turbodiff: installation recovery failed for installation ${installationId}:`,
            err,
          );
        }),
    ),
  ).then(() => undefined);
  repositoryRepairs.set(userId, repair);
  try {
    await repair;
  } finally {
    if (repositoryRepairs.get(userId) === repair) repositoryRepairs.delete(userId);
  }
}

async function installationIds(userId: string): Promise<InstallationResult> {
  const cached = installationsCache.get(userId);
  if (cached && Date.now() - cached.fetchedAt < INSTALLATIONS_TTL_MS) {
    return {
      kind: 'success',
      ids: cached.ids,
      refresh: githubAccessIssues.has(userId)
        ? async () => {
            await refreshInstallationIds(userId);
          }
        : undefined,
    };
  }

  const durable = await installationAccessSnapshot(userId);
  const now = Date.now();
  if (durable) {
    installationsCache.set(userId, {
      ids: durable.installationIds,
      fetchedAt: durable.verifiedAt,
    });
    const age = now - durable.verifiedAt;
    if (age < INSTALLATIONS_TTL_MS) {
      return {
        kind: 'success',
        ids: durable.installationIds,
        refresh: githubAccessIssues.has(userId)
          ? async () => {
              await refreshInstallationIds(userId);
            }
          : undefined,
      };
    }
    if (age < INSTALLATIONS_STALE_MAX_MS) {
      return {
        kind: 'success',
        ids: durable.installationIds,
        refresh: async () => {
          await refreshInstallationIds(userId);
        },
      };
    }
  }

  const fresh = await refreshInstallationIds(userId);
  if (fresh.kind === 'success') {
    return {
      kind: 'success',
      ids: fresh.ids,
      repair: fresh.ids.length > 0 ? () => repairRepositoryMirror(userId, fresh.ids) : undefined,
    };
  }
  if (cached && now - cached.fetchedAt < INSTALLATIONS_STALE_MAX_MS) {
    return { kind: 'success', ids: cached.ids };
  }
  return fresh;
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
      githubStatus: 'ready',
      name: 'dev',
      devFake: true,
    };
  }
  const found = await withAuth((instance) => instance.api.getSession({ headers: request.headers }));
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
      githubStatus: 'not_connected',
      name: user.name || user.email,
    };
  }

  const [resolved, synthetic] = await Promise.all([
    installationIds(user.id),
    cachedSyntheticInstallationIds(githubId),
  ]);
  if (resolved.kind !== 'success') {
    return {
      session: { authUserId: user.id, userId: githubId, login },
      // A GitHub credential problem must not lock a user out of native
      // projects whose authorization is already durable in PostgreSQL.
      installationIds: synthetic,
      githubConnected: true,
      githubStatus: resolved.kind,
      name: login,
    };
  }
  // GitHub cannot know about Artifacts-hosted projects, so membership-derived
  // installation ids are unioned in.
  const accessIssue = githubAccessIssues.get(user.id);
  return {
    session: { authUserId: user.id, userId: githubId, login },
    installationIds: [...new Set([...resolved.ids, ...synthetic])],
    githubConnected: true,
    githubStatus:
      accessIssue ??
      (resolved.ids.length === 0
        ? 'app_not_installed'
        : resolved.repair || repositoryRepairs.has(user.id)
          ? 'syncing'
          : 'ready'),
    name: login,
    membershipRefresh: resolved.refresh,
    repositoryRepair: resolved.repair,
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
  const session = await withAuth((instance) =>
    instance.api.getMcpSession({ headers: request.headers }),
  );
  if (!session?.userId) return null;
  const row = await queryOne<{
    id: string;
    name: string;
    email: string;
    login: string | null;
    githubId: number | null;
  }>(sql`
    SELECT id, name, email, login, "githubId"
    FROM auth."user" WHERE id = ${session.userId}
  `);
  if (!row) return null;
  return resolveAuthedUser(row);
}
