import { ensureBuiltinAgents } from '../../data/agents.ts';
import { getSessionAccess } from '../../data/session-access.ts';
import { getAuthUser } from '../../data/auth-users.ts';
import { claimGithubOrganizations, ensurePersonalOrganization } from '../../data/organizations.ts';
import { withAuth, type AuthUser } from '../../integrations/auth/better-auth.ts';
import { isNumber, isString } from '../../shared/json.ts';

export type AuthedUser = {
  session: {
    authUserId: string;
    githubUserId: number | null;
    login: string | null;
  };
  organizationIds: string[];
  activeOrganizationId: string;
  githubConnected: boolean;
  githubStatus: GitHubStatus;
  name: string;
};

export type GitHubStatus =
  | 'not_connected'
  | 'reauthorization_required'
  | 'temporarily_unavailable'
  | 'app_not_installed'
  | 'syncing'
  | 'ready';

async function resolveAuthedUser(
  identity: AuthUser,
  preferredOrganizationId?: string | null,
): Promise<AuthedUser> {
  let access = await getSessionAccess(identity.id, identity.githubId ?? null);
  if (access.has_unclaimed && identity.githubId) {
    await claimGithubOrganizations(identity.id, identity.githubId);
    access = await getSessionAccess(identity.id, identity.githubId);
  }
  if (access.organization_ids.length === 0) {
    const organization = await ensurePersonalOrganization(
      identity.id,
      identity.name || identity.email,
    );
    await ensureBuiltinAgents(organization.id);
    access = await getSessionAccess(identity.id, identity.githubId ?? null);
  }
  const organizationIds = access.organization_ids;
  const preferred =
    preferredOrganizationId && organizationIds.includes(preferredOrganizationId)
      ? preferredOrganizationId
      : null;
  const activeOrganizationId = preferred ?? organizationIds[0];
  if (!activeOrganizationId) throw new Error('authenticated user has no organization');

  const login = identity.login ?? null;
  const githubUserId = identity.githubId ?? null;
  const githubConnected = login !== null && githubUserId !== null;
  const integrationConnected = access.github_connected;
  return {
    session: { authUserId: identity.id, githubUserId, login },
    organizationIds,
    activeOrganizationId,
    githubConnected,
    githubStatus: githubConnected
      ? integrationConnected
        ? 'ready'
        : 'app_not_installed'
      : 'not_connected',
    name: login ?? identity.name ?? identity.email,
  };
}

export async function requireUser(request: Request): Promise<AuthedUser | null> {
  const found = await withAuth((instance) => instance.api.getSession({ headers: request.headers }));
  if (!found) return null;
  const login = 'login' in found.user && isString(found.user.login) ? found.user.login : null;
  const githubId =
    'githubId' in found.user && isNumber(found.user.githubId) ? found.user.githubId : null;
  return resolveAuthedUser(
    {
      id: found.user.id,
      name: found.user.name,
      email: found.user.email,
      login,
      githubId,
    },
    found.session.activeOrganizationId,
  );
}

export async function requireMcpUser(request: Request): Promise<AuthedUser | null> {
  const token = await withAuth((instance) =>
    instance.api.getMcpSession({ headers: request.headers }),
  );
  if (!token?.userId) return null;
  const identity = await getAuthUser(token.userId);
  return identity ? resolveAuthedUser(identity) : null;
}
