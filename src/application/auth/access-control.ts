import { sql } from 'drizzle-orm';
import { execute, queryOne, queryRows } from '../../data/database.ts';
import { getInstallation } from '../../data/repositories.ts';
import type { AuthedUser, userIsGithubOrgAdmin } from './session.ts';
import { orgRoles, type OrgRole } from '../../integrations/auth/organization-access.ts';

async function orgForInstallation(installationId: number): Promise<{ id: string } | null> {
  return queryOne<{ id: string }>(sql`
    SELECT id FROM auth."organization" WHERE "installationId" = ${installationId}
  `);
}

// Idempotently provisions the organization linked to an installation.
export async function ensureOrganizationForInstallation(
  installationId: number,
  accountLogin: string,
): Promise<string> {
  const existing = await orgForInstallation(installationId);
  if (existing) return existing.id;
  const now = new Date().toISOString();
  await execute(sql`
    INSERT INTO auth."organization" (id, name, slug, "installationId", "createdAt")
    VALUES (
      ${crypto.randomUUID()}, ${accountLogin}, ${accountLogin.toLowerCase()},
      ${installationId}, ${now}
    )
    ON CONFLICT("installationId") DO NOTHING
  `);
  // A concurrent webhook delivery may have won the insert race above.
  const row = await orgForInstallation(installationId);
  if (!row)
    throw new Error(`organization row missing after insert for installation ${installationId}`);
  return row.id;
}

export async function syntheticInstallationIds(githubId: number): Promise<number[]> {
  const rows = await queryRows<{ id: number }>(sql`
    SELECT o."installationId" AS id FROM auth."member" m
    JOIN auth."organization" o ON o.id = m."organizationId"
    JOIN auth."user" u ON u.id = m."userId"
    JOIN app.installations i ON i.id = o."installationId"
    WHERE u."githubId" = ${githubId} AND i.provider = 'artifacts'
  `);
  return rows.map((row) => row.id);
}

export async function ensureOwnerMember(
  organizationId: string,
  installerGithubId: number,
): Promise<void> {
  const user = await queryOne<{ id: string }>(sql`
    SELECT id FROM auth."user" WHERE "githubId" = ${installerGithubId}
  `);
  if (!user) return;
  await execute(sql`
    INSERT INTO auth."member" (id, "organizationId", "userId", role, "createdAt")
    VALUES (
      ${crypto.randomUUID()}, ${organizationId}, ${user.id}, 'owner',
      ${new Date().toISOString()}
    )
    ON CONFLICT("organizationId", "userId") DO NOTHING
  `);
}

// GitHub-authorized users without an explicit role are regular members.
export async function memberRole(organizationId: string, githubId: number): Promise<OrgRole> {
  const row = await queryOne<{ role: string }>(sql`
    SELECT member.role FROM auth."member" AS member
    JOIN auth."user" AS "user" ON "user".id = member."userId"
    WHERE member."organizationId" = ${organizationId} AND "user"."githubId" = ${githubId}
  `);
  return row?.role === 'owner' || row?.role === 'admin' ? row.role : 'member';
}

async function hasMemberRow(organizationId: string, githubId: number): Promise<boolean> {
  const row = await queryOne<{ x: number }>(sql`
    SELECT 1 AS x FROM auth."member" AS member
    JOIN auth."user" AS "user" ON "user".id = member."userId"
    WHERE member."organizationId" = ${organizationId} AND "user"."githubId" = ${githubId}
  `);
  return row !== null;
}

// Makes the recorded installer owner only while the organization has no members.
async function ensureInstallerOwner(
  user: AuthedUser,
  organizationId: string,
  installerGithubId: number | null,
): Promise<void> {
  if (installerGithubId === null) return;
  if (user.session.userId !== installerGithubId) return;
  const count = await queryOne<{ n: number }>(sql`
    SELECT COUNT(*) AS n FROM auth."member" WHERE "organizationId" = ${organizationId}
  `);
  if (!count || count.n > 0) return;
  await ensureOwnerMember(organizationId, user.session.userId);
}

// Bootstraps a GitHub organization admin only when no explicit role exists.
async function ensureGithubAdminOwner(
  user: AuthedUser,
  organizationId: string,
  accountLogin: string,
  isOrgAdmin: typeof userIsGithubOrgAdmin,
): Promise<void> {
  if (await hasMemberRow(organizationId, user.session.userId)) return;
  if (!(await isOrgAdmin(user, accountLogin))) return;
  await ensureOwnerMember(organizationId, user.session.userId);
}

// Prevents a sole explicit member from being unable to administer the organization.
async function ensureSoleMemberOwner(user: AuthedUser, organizationId: string): Promise<void> {
  await execute(sql`
    UPDATE auth."member" SET role = 'owner'
    WHERE "organizationId" = ${organizationId}
      AND role <> 'owner'
      AND "userId" IN (
        SELECT id FROM auth."user" WHERE "githubId" = ${user.session.userId}
      )
      AND (
        SELECT COUNT(*) FROM auth."member" m2
        WHERE m2."organizationId" = ${organizationId}
      ) = 1
  `);
}

// Repairs missing organization linkage and ownership while resolving access.
export async function orgForInstallationWithHeal(
  user: AuthedUser,
  installationId: number,
  isOrgAdmin: typeof userIsGithubOrgAdmin,
): Promise<{ id: string } | null> {
  const installation = await getInstallation(installationId);
  let org = await orgForInstallation(installationId);
  if (!org) {
    if (!installation || installation.account_type !== 'Organization') return null;
    org = {
      id: await ensureOrganizationForInstallation(installationId, installation.account_login),
    };
  }
  if (installation) {
    await ensureInstallerOwner(user, org.id, installation.installer_github_id);
    await ensureGithubAdminOwner(user, org.id, installation.account_login, isOrgAdmin);
  }
  await ensureSoleMemberOwner(user, org.id);
  return org;
}

export async function capabilityDenied(
  user: AuthedUser,
  installationId: number,
  action: 'member' | 'settings',
  isOrgAdmin: typeof userIsGithubOrgAdmin,
): Promise<string | null> {
  const org = await orgForInstallationWithHeal(user, installationId, isOrgAdmin);
  if (!org) return null;
  const role = await memberRole(org.id, user.session.userId);
  const request =
    action === 'member' ? { member: ['update'] as const } : { settings: ['update'] as const };
  if (orgRoles[role].authorize(request).success) return null;
  return `'${action}' capability required for this organization`;
}

export async function organizationSummary(
  organizationId: string,
): Promise<{ name: string; installationId: number } | null> {
  return queryOne<{ name: string; installationId: number }>(sql`
    SELECT name, "installationId" FROM auth."organization" WHERE id = ${organizationId}
  `);
}

export async function inviterLabel(userId: string): Promise<string | null> {
  const row = await queryOne<{ login: string | null; name: string }>(sql`
    SELECT login, name FROM auth."user" WHERE id = ${userId}
  `);
  if (!row) return null;
  return row.login ? `@${row.login}` : row.name;
}
