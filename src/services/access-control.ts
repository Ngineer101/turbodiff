import { env } from 'cloudflare:workers';
import { getInstallation } from '../data/repositories.ts';
import type { AuthedUser, userIsGithubOrgAdmin } from './auth.ts';
import { orgRoles, type OrgRole } from '../integrations/auth/organization-access.ts';

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
// The better-auth organization row linked to this installation, if any.
// Read-only lookup — organization/member row creation happens from the
// webhook provisioning path (ensureOrganizationForInstallation below) and,
// for installations whose webhook delivery was missed, lazily from
// orgForInstallationWithHeal on request paths.
async function orgForInstallation(installationId: number): Promise<{ id: string } | null> {
  return env.DB.prepare('SELECT id FROM "organization" WHERE "installationId" = ?1')
    .bind(installationId)
    .first<{ id: string }>();
}

// Idempotent: creates the linked organization row for an Organization-type
// installation if one doesn't already exist, returning its id either way.
// Called from the installation/installation_repositories webhook handlers
// (src/services/github-webhooks.ts) and from orgForInstallationWithHeal
// below, which self-heals installations whose provisioning webhook was
// missed (or that predate migrations/0031_organizations.sql).
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

// Records a GitHub user as the organization's owner — called for the App
// installer from the `installation created` webhook, and from the
// GitHub-admin bootstrap below (ensureGithubAdminOwner) for orgs provisioned
// without an installer identity. Only possible if the user already has a
// better-auth `user` row (i.e. they signed in to Turbodiff before or after
// installing the app). If they haven't yet, this is a no-op: the
// auto-provisioning fallback in memberRole treats them as an implicit
// 'member' (never locked out) until their first sign-in, at which point an
// existing owner/admin can promote them via
// PATCH /organizations/:installationId/members/:memberId — or, if they end
// up the org's only member, the sole-member heal in
// orgForInstallationWithHeal promotes them itself.
// Synthetic Artifacts installations a user can reach via an explicit member
// row (docs/artifacts-provider.md). GitHub installations come from GitHub's
// own answer (auth.ts); these have no GitHub side, so membership in the
// linked organization IS the access grant. Uncached on purpose: a freshly
// created project must appear on the next request.
export async function syntheticInstallationIds(githubId: number): Promise<number[]> {
  const rows = await env.DB.prepare(
    `SELECT o."installationId" AS id FROM "member" m
		 JOIN "organization" o ON o.id = m."organizationId"
		 JOIN "user" u ON u.id = m."userId"
		 WHERE u."githubId" = ?1 AND o."installationId" < 0`,
  )
    .bind(githubId)
    .all<{ id: number }>();
  return rows.results.map((r) => r.id);
}

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

// Whether the user has an explicit member row — memberRole cannot tell an
// explicit 'member' row from the implicit fallback, and explicit in-app role
// assignments must win over GitHub-derived elevation.
async function hasMemberRow(organizationId: string, githubId: number): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS x FROM "member"
     JOIN "user" ON "user".id = "member"."userId"
     WHERE "member"."organizationId" = ?1 AND "user"."githubId" = ?2`,
  )
    .bind(organizationId, githubId)
    .first();
  return row !== null;
}

// First-owner bootstrap for orgs provisioned without an `installation
// created` webhook (no installer identity): a caller with no member row who
// is an admin (owner) of the org on GitHub becomes this org's owner. Runs
// only when there is no explicit row, so in-app demotions are never undone.
async function ensureGithubAdminOwner(
  user: AuthedUser,
  organizationId: string,
  accountLogin: string,
  isOrgAdmin: typeof userIsGithubOrgAdmin,
): Promise<void> {
  if (user.devFake || !user.session.ghToken) return;
  if (await hasMemberRow(organizationId, user.session.userId)) return;
  if (!(await isOrgAdmin(user, accountLogin))) return;
  await ensureOwnerMember(organizationId, user.session.userId);
}

// Sole-member promotion: an organization whose only explicit member row
// belongs to the caller implicitly makes them its owner — the shapes that
// produce a sole non-owner row (an artifacts org whose creator had no user
// row when ensureOwnerMember ran; a GitHub org whose bootstrapped owner
// left; a failed GitHub admin check) all leave a lone human with no way to
// invite anyone. better-auth's last-owner guard means a sole 'member'/'admin'
// row can never result from a legitimate in-app demotion, so this never
// reverses an intentional decision. Persistent on purpose: better-auth's
// invitation/member endpoints re-check the stored row internally. Deliberately
// requires the caller to BE the sole row — a caller with no row on a zero-row
// org must keep going through the GitHub-admin bootstrap above.
async function ensureSoleMemberOwner(user: AuthedUser, organizationId: string): Promise<void> {
  if (user.devFake) return;
  await env.DB.prepare(
    `UPDATE "member" SET role = 'owner'
     WHERE "organizationId" = ?1
       AND role <> 'owner'
       AND "userId" IN (SELECT id FROM "user" WHERE "githubId" = ?2)
       AND (SELECT COUNT(*) FROM "member" m2 WHERE m2."organizationId" = ?1) = 1`,
  )
    .bind(organizationId, user.session.userId)
    .run();
}

// Resolve an installation to its linked organization, provisioning the row
// if the webhook that should have created it was missed (installations that
// predate migrations/0031_organizations.sql, or dropped deliveries). Also
// bootstraps the first owner from GitHub: see ensureGithubAdminOwner. Also
// normalizes a sole member row belonging to the caller to 'owner': see
// ensureSoleMemberOwner. Null for personal (User-type) installations and
// unknown installation ids.
// A pre-existing org row keeps gating even if the installations row is
// missing or odd — orgForInstallation is consulted before the account_type
// gate.
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
    // The GitHub call inside runs only for callers with no member row —
    // exactly the callers who would otherwise be denied — and is cached 5
    // minutes in userIsGithubOrgAdmin, so owners/admins with rows never
    // trigger it.
    await ensureGithubAdminOwner(user, org.id, installation.account_login, isOrgAdmin);
  }
  // Outside the `if (installation)` guard: the sole-member rule needs nothing
  // from GitHub, and a pre-existing org row keeps gating even when the
  // installations row is missing (see the comment above). Runs after the
  // GitHub bootstrap, which only inserts (as 'owner') when the caller has no
  // row — so a freshly bootstrapped admin makes this a no-op.
  await ensureSoleMemberOwner(user, org.id);
  return org;
}

// Gate for the in-app actions layered on top of installation membership
// (member management, app configuration). Null means allowed; a denial
// message otherwise — the HTTP layer maps it to a 403 (requireCapability in
// http/api-support.ts). A personal (User-type) installation has no linked
// organization by construction (the heal only provisions Organization-type
// installations), so every caller who already cleared the installationIds
// check is fully permitted there — GitHub membership is already the whole
// authorization story for a personal installation. A missing org row for an
// Organization-type installation is provisioned here (a GET-time heal that
// writes to D1 deliberately — same precedent as the GET /settings repo
// self-heal in src/http/api.ts), so a GitHub org admin is never locked out
// of settings writes just because they haven't visited the members page yet.
export async function capabilityDenied(
  user: AuthedUser,
  installationId: number,
  action: 'member' | 'settings',
  isOrgAdmin: typeof userIsGithubOrgAdmin,
): Promise<string | null> {
  if (user.devFake) return null;
  const org = await orgForInstallationWithHeal(user, installationId, isOrgAdmin);
  if (!org) return null;
  const role = await memberRole(org.id, user.session.userId);
  const request =
    action === 'member' ? { member: ['update'] as const } : { settings: ['update'] as const };
  if (orgRoles[role].authorize(request).success) return null;
  return `'${action}' capability required for this organization`;
}
