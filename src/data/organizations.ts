import { sql } from 'drizzle-orm';
import { BUILTIN_AGENTS } from '../domain/agent-definitions.ts';
import { execute, queryOne, queryRows, withTransaction } from './postgres.ts';

export interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  created_at: string;
}

export interface OrganizationMembershipRow extends OrganizationRow {
  role: 'owner' | 'admin' | 'member';
}

export interface OrganizationMemberRow {
  id: string;
  user_id: string;
  login: string | null;
  email: string;
  role: string;
  created_at: string;
}

export interface OrganizationInvitationRow {
  id: string;
  email: string;
  role: string;
  status: string;
  expires_at: string;
}

function organizationSlug(name: string, id: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `${base || 'workspace'}-${id.slice(0, 8)}`;
}

function personalOrganizationMetadata(userId: string): string {
  return JSON.stringify({ kind: 'personal', ownerUserId: userId });
}

const pristineBuiltinAgent = sql.join(
  BUILTIN_AGENTS.map(
    (agent) => sql`(
      candidate.definition_key = ${agent.definitionKey}
      AND candidate.slug = ${agent.slug}
      AND candidate.name = ${agent.name}
      AND candidate.description IS NOT DISTINCT FROM ${agent.description}
      AND candidate.instructions_override IS NOT DISTINCT FROM ${agent.instructionsOverride}
      AND candidate.enabled
    )`,
  ),
  sql` OR `,
);

export async function listOrganizationsForUser(userId: string): Promise<OrganizationRow[]> {
  return queryRows<OrganizationRow>(sql`
    SELECT o.id, o.name, o.slug, o."createdAt" AS created_at
    FROM auth."organization" o
    JOIN auth."member" m ON m."organizationId" = o.id
    WHERE m."userId" = ${userId}
    ORDER BY o."createdAt", o.id
  `);
}

export async function listOrganizationMembershipsForUser(
  userId: string,
): Promise<OrganizationMembershipRow[]> {
  return queryRows<OrganizationMembershipRow>(sql`
    SELECT o.id, o.name, o.slug, o."createdAt" AS created_at, m.role
    FROM auth."organization" o
    JOIN auth."member" m ON m."organizationId" = o.id
    WHERE m."userId" = ${userId}
    ORDER BY o."createdAt", o.id
  `);
}

export async function getOrganization(id: string): Promise<OrganizationRow | null> {
  return queryOne<OrganizationRow>(sql`
    SELECT id, name, slug, "createdAt" AS created_at
    FROM auth."organization"
    WHERE id = ${id}
  `);
}

export async function findAuthUserByGithubId(githubId: number): Promise<string | null> {
  const row = await queryOne<{ id: string }>(sql`
    SELECT id FROM auth."user" WHERE "githubId" = ${githubId}
  `);
  return row?.id ?? null;
}

export async function ensureGithubOrganization(input: {
  accountId: number;
  accountLogin: string;
  ownerUserId?: string | null;
}): Promise<OrganizationRow> {
  const id = `github-account-${input.accountId}`;
  const now = new Date().toISOString();
  await execute(sql`
    INSERT INTO auth."organization" (id, name, slug, metadata, "createdAt")
    VALUES (
      ${id}, ${input.accountLogin},
      ${`${input.accountLogin.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${input.accountId}`},
      ${JSON.stringify({ githubAccountId: input.accountId })}, ${now}
    )
    ON CONFLICT(id) DO UPDATE SET name = excluded.name
  `);
  if (input.ownerUserId) await addOrganizationOwner(id, input.ownerUserId);
  const row = await getOrganization(id);
  if (!row) throw new Error('GitHub organization insert returned no row');
  return row;
}

export async function claimGithubOrganizations(userId: string, githubId: number): Promise<void> {
  const organizationIds = await queryRows<{ organization_id: string }>(sql`
    SELECT DISTINCT integration.organization_id
    FROM app.integrations integration
    WHERE integration.provider = 'github'
      AND integration.config->>'installerGithubId' = ${String(githubId)}
      AND NOT EXISTS (
        SELECT 1 FROM auth."member" membership
        WHERE membership."organizationId" = integration.organization_id
      )
  `);
  for (const row of organizationIds) await addOrganizationOwner(row.organization_id, userId);
}

export async function ensurePersonalOrganization(
  userId: string,
  name: string,
): Promise<OrganizationRow> {
  return withTransaction(async (transaction) => {
    await transaction.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`turbodiff:personal-organization:${userId}`}, 0)
      )
    `);

    const existing = (await listOrganizationsForUser(userId))[0];
    if (existing) return existing;

    const organizationId = crypto.randomUUID();
    const now = new Date().toISOString();
    await transaction.execute(sql`
      INSERT INTO auth."organization" (id, name, slug, metadata, "createdAt")
      VALUES (
        ${organizationId}, ${name}, ${organizationSlug(name, organizationId)},
        ${personalOrganizationMetadata(userId)}, ${now}
      )
    `);
    await transaction.execute(sql`
      INSERT INTO auth."member" (id, "organizationId", "userId", role, "createdAt")
      VALUES (${crypto.randomUUID()}, ${organizationId}, ${userId}, 'owner', ${now})
    `);
    const created = await getOrganization(organizationId);
    if (!created) throw new Error('organization insert returned no row');
    return created;
  });
}

export async function deletePristinePersonalOrganization(
  userId: string,
  retainedOrganizationId: string,
): Promise<string | null> {
  const deleted = await queryOne<{ id: string }>(sql`
    DELETE FROM auth."organization" personal
    WHERE personal.id <> ${retainedOrganizationId}
      AND personal.metadata = ${personalOrganizationMetadata(userId)}
      AND EXISTS (
        SELECT 1 FROM auth."member" owner_membership
        WHERE owner_membership."organizationId" = personal.id
          AND owner_membership."userId" = ${userId}
          AND owner_membership.role = 'owner'
      )
      AND NOT EXISTS (
        SELECT 1 FROM auth."member" other_membership
        WHERE other_membership."organizationId" = personal.id
          AND other_membership."userId" <> ${userId}
      )
      AND NOT EXISTS (
        SELECT 1 FROM auth."invitation" invitation
        WHERE invitation."organizationId" = personal.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM app.integrations integration
        WHERE integration.organization_id = personal.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM app.repositories repository
        WHERE repository.organization_id = personal.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM app.agents candidate
        WHERE candidate.organization_id = personal.id
          AND NOT (${pristineBuiltinAgent})
      )
      AND NOT EXISTS (
        SELECT 1 FROM app.skills skill WHERE skill.organization_id = personal.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM app.automations automation WHERE automation.organization_id = personal.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM app.work_items work_item WHERE work_item.organization_id = personal.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM app.artifacts artifact WHERE artifact.organization_id = personal.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM app.factory_runs factory_run WHERE factory_run.organization_id = personal.id
      )
    RETURNING personal.id
  `);
  return deleted?.id ?? null;
}

export async function addOrganizationOwner(organizationId: string, userId: string): Promise<void> {
  await execute(sql`
    INSERT INTO auth."member" (id, "organizationId", "userId", role, "createdAt")
    VALUES (
      ${crypto.randomUUID()}, ${organizationId}, ${userId}, 'owner',
      ${new Date().toISOString()}
    )
    ON CONFLICT("organizationId", "userId") DO UPDATE SET role = 'owner'
  `);
}

export async function memberRole(
  organizationId: string,
  userId: string,
): Promise<'owner' | 'admin' | 'member' | null> {
  const row = await queryOne<{ role: string }>(sql`
    SELECT role FROM auth."member"
    WHERE "organizationId" = ${organizationId} AND "userId" = ${userId}
  `);
  if (!row) return null;
  if (row.role === 'owner' || row.role === 'admin') return row.role;
  return 'member';
}

export async function listMembers(organizationId: string): Promise<OrganizationMemberRow[]> {
  return queryRows<OrganizationMemberRow>(sql`
    SELECT m.id, m."userId" AS user_id, u.login, u.email, m.role,
      m."createdAt" AS created_at
    FROM auth."member" m
    JOIN auth."user" u ON u.id = m."userId"
    WHERE m."organizationId" = ${organizationId}
    ORDER BY m."createdAt", m.id
  `);
}

export async function listPendingInvitations(
  organizationId: string,
): Promise<OrganizationInvitationRow[]> {
  return queryRows<OrganizationInvitationRow>(sql`
    SELECT id, email, role, status, "expiresAt" AS expires_at
    FROM auth."invitation"
    WHERE "organizationId" = ${organizationId} AND status = 'pending'
    ORDER BY "createdAt" DESC
  `);
}

export async function inviterLabel(userId: string): Promise<string | null> {
  const row = await queryOne<{ login: string | null; name: string }>(sql`
    SELECT login, name FROM auth."user" WHERE id = ${userId}
  `);
  if (!row) return null;
  return row.login ? `@${row.login}` : row.name;
}
