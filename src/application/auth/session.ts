import { sql } from 'drizzle-orm';
import { queryOne, sqlValueList } from '../../data/postgres.ts';
import { ensureBuiltinAgents } from '../../data/agents.ts';
import {
  claimGithubOrganizations,
  ensurePersonalOrganization,
  listOrganizationsForUser,
} from '../../data/organizations.ts';
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

async function hasGithubIntegration(organizationIds: string[]): Promise<boolean> {
  if (organizationIds.length === 0) return false;
  const row = await queryOne<{ connected: boolean }>(sql`
    SELECT EXISTS(
      SELECT 1 FROM app.integrations
      WHERE organization_id IN (${sqlValueList(organizationIds)})
        AND kind = 'scm' AND provider = 'github' AND enabled
    ) AS connected
  `);
  return row?.connected ?? false;
}

async function resolveAuthedUser(
  identity: AuthUser,
  preferredOrganizationId?: string | null,
): Promise<AuthedUser> {
  if (identity.githubId) await claimGithubOrganizations(identity.id, identity.githubId);
  let organizations = await listOrganizationsForUser(identity.id);
  if (organizations.length === 0) {
    await ensurePersonalOrganization(identity.id, identity.name || identity.email);
    organizations = await listOrganizationsForUser(identity.id);
  }
  const organizationIds = organizations.map((organization) => organization.id);
  const preferred =
    preferredOrganizationId && organizationIds.includes(preferredOrganizationId)
      ? preferredOrganizationId
      : null;
  const activeOrganizationId = preferred ?? organizationIds[0];
  if (!activeOrganizationId) throw new Error('authenticated user has no organization');
  await ensureBuiltinAgents(activeOrganizationId);

  const login = identity.login ?? null;
  const githubUserId = identity.githubId ?? null;
  const githubConnected = login !== null && githubUserId !== null;
  const integrationConnected = await hasGithubIntegration(organizationIds);
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
  const identity = await queryOne<AuthUser>(sql`
    SELECT id, name, email, login, "githubId" AS "githubId"
    FROM auth."user"
    WHERE id = ${token.userId}
  `);
  return identity ? resolveAuthedUser(identity) : null;
}
