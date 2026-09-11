import { sql } from 'drizzle-orm';
import { queryOne } from '../../data/database.ts';
import { ensureBuiltinAgents } from '../../data/db.ts';
import { withAuth, type AuthUser } from '../../integrations/auth/better-auth.ts';
import {
  installationAccessSnapshot,
  storeInstallationAccessSnapshot,
} from '../../data/performance.ts';
import { syntheticInstallationIds } from './access-control.ts';
import {
  fetchUserCanPush,
  fetchUserInstallationIds,
  fetchUserOrgRole,
} from '../../integrations/github/app.ts';
import { GitHubApiError } from '../../integrations/github/client.ts';
import { isNumber, isString } from '../../shared/json.ts';
import { syncInstallationRepos } from '../repositories/sync.ts';

export type AuthedUser = {
  // GitHub identity is empty for password-only accounts.
  session: { authUserId: string; userId: number; login: string };
  installationIds: number[];
  githubConnected: boolean;
  githubStatus: GitHubStatus;
  // Display identity for the shell — the GitHub login when connected, the
  // sign-up name otherwise.
  name: string;
  // Deferred refreshes run after the response.
  membershipRefresh?: () => Promise<void>;
  // Deferred repairs rebuild the repository mirror after migration.
  repositoryRepair?: () => Promise<void>;
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
const SYNTHETIC_TTL_MS = 60_000;
const syntheticCache = new Map<number, { ids: number[]; fetchedAt: number }>();

async function cachedSyntheticInstallationIds(githubId: number): Promise<number[]> {
  const cached = syntheticCache.get(githubId);
  if (cached && Date.now() - cached.fetchedAt < SYNTHETIC_TTL_MS) return cached.ids;
  const ids = await syntheticInstallationIds(githubId);
  syntheticCache.set(githubId, { ids, fetchedAt: Date.now() });
  return ids;
}

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
  if (!user.session.authUserId) return '';
  return githubToken(user.session.authUserId);
}

// Repository writes require the user's own GitHub push permission.
const REPO_PERM_TTL_MS = 5 * 60_000;
const repoPermCache = new Map<string, { push: boolean; fetchedAt: number }>();

export async function userCanPushToRepo(
  user: AuthedUser,
  owner: string,
  name: string,
): Promise<boolean> {
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

export async function userIsGithubOrgAdmin(user: AuthedUser, orgLogin: string): Promise<boolean> {
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
  const found = await withAuth((instance) => instance.api.getSession({ headers: request.headers }));
  if (!found) return null;
  const user = found.user;
  // better-auth's static session type erases the login/githubId
  // additionalFields, so narrow them through guards.
  const login = 'login' in user && isString(user.login) && user.login ? user.login : null;
  const githubId = 'githubId' in user && isNumber(user.githubId) ? user.githubId : null;
  return resolveAuthedUser({ id: user.id, name: user.name, email: user.email, login, githubId });
}

async function resolveAuthedUser(user: AuthUser): Promise<AuthedUser | null> {
  const login = user.login ?? null;
  const githubId = user.githubId ?? null;
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
