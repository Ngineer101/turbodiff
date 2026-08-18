import { env } from 'cloudflare:workers';
import { createAccessControl } from 'better-auth/plugins/access';
import { defaultStatements } from 'better-auth/plugins/organization/access';
import type { Context } from 'hono';
import type { AuthedUser } from './auth.ts';

// Native org roles on top of GitHub installation membership (migration
// 0031_organizations.sql). The hybrid model: GitHub installation access is
// still the baseline for reading/using an installation (see requireUser in
// auth.ts) — these roles only gate the *additional* in-app actions below
// (member management, app configuration), never installation-wide reads.
//
// The 'settings' resource is Turbodiff's own addition; 'organization',
// 'member', 'invitation', 'team', and 'ac' are better-auth's own resources
// (defaultStatements) — kept at their default action vocabulary (rather than
// inventing e.g. member:['invite','remove']) because better-auth's built-in
// invite-member / remove-member / update-member-role endpoints check
// permissions against those exact resource:action pairs internally. Using
// the same vocabulary lets the API routes call those endpoints directly
// (createInvitation, removeMember, updateMemberRole) instead of
// reimplementing invitation creation, member removal, and the "can't remove
// the last owner" guard by hand.
const orgStatement = {
  ...defaultStatements,
  settings: ['update'],
} as const;

export const orgAc = createAccessControl(orgStatement);

// Owner and admin get full access in v1 — Owner is distinguished
// operationally (see the last-owner guard in better-auth's own
// removeMember/updateMemberRole endpoints) rather than by a larger
// permission set yet. Member gets neither member-management nor
// settings capability, only whatever GitHub installation access already grants.
export const orgRoles = {
  owner: orgAc.newRole({
    organization: ['update', 'delete'],
    member: ['create', 'update', 'delete'],
    invitation: ['create', 'cancel'],
    team: [],
    ac: [],
    settings: ['update'],
  }),
  admin: orgAc.newRole({
    organization: ['update'],
    member: ['create', 'update', 'delete'],
    invitation: ['create', 'cancel'],
    team: [],
    ac: [],
    settings: ['update'],
  }),
  member: orgAc.newRole({
    organization: [],
    member: [],
    invitation: [],
    team: [],
    ac: [],
    settings: [],
  }),
};

export type OrgRole = keyof typeof orgRoles;

// The better-auth organization row linked to this installation, if any.
// Read-only lookup — organization/member row creation happens only from the
// webhook provisioning path (ensureOrganizationForInstallation below), never
// implicitly from a request handler.
export async function orgForInstallation(installationId: number): Promise<{ id: string } | null> {
  return env.DB.prepare('SELECT id FROM "organization" WHERE "installationId" = ?1')
    .bind(installationId)
    .first<{ id: string }>();
}

// Idempotent: creates the linked organization row for an Organization-type
// installation if one doesn't already exist, returning its id either way.
// Called only from the installation/installation_repositories webhook
// handlers (src/routes/webhooks.ts) — never from a request path.
export async function ensureOrganizationForInstallation(
  installationId: number,
  accountLogin: string,
): Promise<string> {
  const existing = await orgForInstallation(installationId);
  if (existing) return existing.id;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO "organization" (id, name, slug, "installationId", "createdAt")
		 VALUES (?1, ?2, ?3, ?4, ?5)
		 ON CONFLICT("installationId") DO NOTHING`,
  )
    .bind(crypto.randomUUID(), accountLogin, accountLogin.toLowerCase(), installationId, now)
    .run();
  // A concurrent webhook delivery may have won the insert race above.
  const row = await orgForInstallation(installationId);
  if (!row)
    throw new Error(`organization row missing after insert for installation ${installationId}`);
  return row.id;
}

// Records the GitHub App installer as the organization's owner — only
// possible if they already have a better-auth `user` row (i.e. they signed
// in to Turbodiff before or after installing the app). If they haven't yet,
// this is a no-op: the auto-provisioning fallback in memberRole treats them
// as an implicit 'member' (never locked out) until their first sign-in, at
// which point an existing owner/admin can promote them via
// PATCH /organizations/:installationId/members/:memberId.
export async function ensureOwnerMember(
  organizationId: string,
  installerGithubId: number,
): Promise<void> {
  const user = await env.DB.prepare('SELECT id FROM "user" WHERE "githubId" = ?1')
    .bind(installerGithubId)
    .first<{ id: string }>();
  if (!user) return;
  await env.DB.prepare(
    `INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt")
		 VALUES (?1, ?2, ?3, 'owner', ?4)
		 ON CONFLICT("organizationId", "userId") DO NOTHING`,
  )
    .bind(crypto.randomUUID(), organizationId, user.id, new Date().toISOString())
    .run();
}

// The caller's role in an organization, keyed by their GitHub user id (the
// identity AuthedUser.session.userId already carries — see auth.ts). Never
// null: a GitHub-authorized user with no member row yet is an implicit
// 'member' (the auto-provisioning decision — hybrid access never locks
// someone out of an installation they have real GitHub access to).
export async function memberRole(organizationId: string, githubId: number): Promise<OrgRole> {
  const row = await env.DB.prepare(
    `SELECT "member".role AS role FROM "member"
		 JOIN "user" ON "user".id = "member"."userId"
		 WHERE "member"."organizationId" = ?1 AND "user"."githubId" = ?2`,
  )
    .bind(organizationId, githubId)
    .first<{ role: string }>();
  return row?.role === 'owner' || row?.role === 'admin' ? row.role : 'member';
}

type ApiEnv = { Variables: { user: AuthedUser } };

// Gate for the in-app actions layered on top of installation membership
// (member management, app configuration). Null means allowed — the same
// null-means-allowed, Response-means-403 contract as requireRepoPush in
// api.ts. A personal (User-type) installation has no linked organization by
// construction (ensureOrganizationForInstallation only runs for
// Organization-type installations), so every caller who already cleared the
// installationIds check is fully permitted there — GitHub membership is
// already the whole authorization story for a personal installation.
export async function requireCapability(
  c: Context<ApiEnv>,
  installationId: number,
  action: 'member' | 'settings',
): Promise<Response | null> {
  const user = c.get('user');
  if (user.devFake) return null;
  const org = await orgForInstallation(installationId);
  if (!org) return null;
  const role = await memberRole(org.id, user.session.userId);
  const request =
    action === 'member' ? { member: ['update'] as const } : { settings: ['update'] as const };
  if (orgRoles[role].authorize(request).success) return null;
  return c.json({ error: `'${action}' capability required for this organization` }, 403);
}
