import { env } from 'cloudflare:workers';

// Thin typed layer over the D1 config store (schema in migrations/).

export interface InstallationRow {
  id: number;
  account_login: string;
  account_id: number;
  account_type: string;
  suspended: number;
}

export interface RepositoryRow {
  id: number;
  installation_id: number;
  owner: string;
  name: string;
  enabled: number;
  review_on_push: number; // re-dispatch tiered agents on pushes to open PRs
  blocking_reviews: number; // P1 → REQUEST_CHANGES, clean → APPROVE
  auto_fix: number; // dispatch the fix agent when a blocking review lands
  auto_merge: number; // merge factory PRs when verification + review are clean
  auto_resolve_conflicts: number; // dispatch the fix agent to resolve a merge conflict
  demo_videos: number; // record a verification demo video (runtime auto-detected)
  launchable: number | null; // cached detection: null unknown, 1 yes, 0 no
  check_command: string | null; // sandbox verification gate before factory pushes
  run_command: string | null; // how to launch the app for runtime verification
  app_port: number | null; // port the launched app listens on
  model: string | null;
  created_at: string; // when the repo was connected (mirrored into D1)
}

interface WebhookAccount {
  login: string;
  id: number;
  type: string;
}

interface WebhookRepo {
  id: number;
  name: string;
  full_name: string;
}

export async function upsertInstallation(id: number, account: WebhookAccount): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO installations (id, account_login, account_id, account_type, suspended)
		 VALUES (?1, ?2, ?3, ?4, 0)
		 ON CONFLICT(id) DO UPDATE SET account_login = ?2, account_id = ?3, account_type = ?4, suspended = 0`,
  )
    .bind(id, account.login, account.id, account.type)
    .run();
}

export async function deleteInstallation(id: number): Promise<void> {
  // D1 doesn't enforce foreign keys by default, so cascade by hand.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM repositories WHERE installation_id = ?1').bind(id),
    env.DB.prepare('DELETE FROM installations WHERE id = ?1').bind(id),
  ]);
}

export async function setInstallationSuspended(id: number, suspended: boolean): Promise<void> {
  await env.DB.prepare('UPDATE installations SET suspended = ?2 WHERE id = ?1')
    .bind(id, suspended ? 1 : 0)
    .run();
}

export async function addRepositories(installationId: number, repos: WebhookRepo[]): Promise<void> {
  if (repos.length === 0) return;
  await env.DB.batch(
    repos.map((r) => {
      const [owner, name] = r.full_name.split('/');
      return env.DB.prepare(
        `INSERT INTO repositories (id, installation_id, owner, name)
				 VALUES (?1, ?2, ?3, ?4)
				 ON CONFLICT(id) DO UPDATE SET installation_id = ?2, owner = ?3, name = ?4`,
      ).bind(r.id, installationId, owner, name);
    }),
  );
}

export async function listRepositoryIdsForInstallation(installationId: number): Promise<number[]> {
  const rows = await env.DB.prepare('SELECT id FROM repositories WHERE installation_id = ?1')
    .bind(installationId)
    .all<{ id: number }>();
  return rows.results.map((r) => r.id);
}

export async function removeRepositories(repoIds: number[]): Promise<void> {
  if (repoIds.length === 0) return;
  await env.DB.batch(
    repoIds.map((id) => env.DB.prepare('DELETE FROM repositories WHERE id = ?1').bind(id)),
  );
}

export async function getRepoByFullName(
  owner: string,
  name: string,
): Promise<RepositoryRow | null> {
  return env.DB.prepare('SELECT * FROM repositories WHERE owner = ?1 AND name = ?2')
    .bind(owner, name)
    .first<RepositoryRow>();
}

export async function getInstallation(id: number): Promise<InstallationRow | null> {
  return env.DB.prepare('SELECT * FROM installations WHERE id = ?1')
    .bind(id)
    .first<InstallationRow>();
}

export async function listInstallationsWithRepos(
  installationIds: number[],
): Promise<{ installation: InstallationRow; repos: RepositoryRow[] }[]> {
  if (installationIds.length === 0) return [];
  const placeholders = installationIds.map((_, i) => `?${i + 1}`).join(', ');
  const [installations, repos] = await Promise.all([
    env.DB.prepare(
      `SELECT * FROM installations WHERE id IN (${placeholders}) ORDER BY account_login`,
    )
      .bind(...installationIds)
      .all<InstallationRow>(),
    env.DB.prepare(
      `SELECT * FROM repositories WHERE installation_id IN (${placeholders}) ORDER BY owner, name`,
    )
      .bind(...installationIds)
      .all<RepositoryRow>(),
  ]);
  return installations.results.map((installation) => ({
    installation,
    repos: repos.results.filter((r) => r.installation_id === installation.id),
  }));
}

export interface OrgMemberRow {
  id: string;
  login: string | null;
  email: string;
  role: string;
  created_at: string;
}

export interface OrgInvitationRow {
  id: string;
  email: string;
  role: string;
  status: string;
  expires_at: string | null;
}

// The members page's read side: joins better-auth's member/user tables for
// display (login isn't on `member` itself). Written here rather than
// through the organization plugin's own listMembers endpoint because that
// endpoint requires the caller to already have a member row in the org —
// the hybrid access model reads (GET /organizations/:id/members) with plain
// installation membership instead, same bar as every other GET route.
export async function listMembersWithGithubLogin(organizationId: string): Promise<OrgMemberRow[]> {
  const rows = await env.DB.prepare(
    `SELECT "member".id AS id, "user".login AS login, "user".email AS email,
			        "member".role AS role, "member"."createdAt" AS created_at
		 FROM "member" JOIN "user" ON "user".id = "member"."userId"
		 WHERE "member"."organizationId" = ?1
		 ORDER BY "member"."createdAt"`,
  )
    .bind(organizationId)
    .all<OrgMemberRow>();
  return rows.results;
}

export async function listPendingInvitations(organizationId: string): Promise<OrgInvitationRow[]> {
  const rows = await env.DB.prepare(
    `SELECT id, email, role, status, "expiresAt" AS expires_at
		 FROM "invitation"
		 WHERE "organizationId" = ?1 AND status = 'pending'
		 ORDER BY "createdAt"`,
  )
    .bind(organizationId)
    .all<OrgInvitationRow>();
  return rows.results;
}

export async function getRepoById(id: number): Promise<RepositoryRow | null> {
  return env.DB.prepare('SELECT * FROM repositories WHERE id = ?1').bind(id).first<RepositoryRow>();
}

export async function setRepoEnabled(id: number, enabled: boolean): Promise<void> {
  await env.DB.prepare('UPDATE repositories SET enabled = ?2 WHERE id = ?1')
    .bind(id, enabled ? 1 : 0)
    .run();
}

export async function setRepoReviewOnPush(id: number, on: boolean): Promise<void> {
  await env.DB.prepare('UPDATE repositories SET review_on_push = ?2 WHERE id = ?1')
    .bind(id, on ? 1 : 0)
    .run();
}

export async function setRepoBlockingReviews(id: number, on: boolean): Promise<void> {
  await env.DB.prepare('UPDATE repositories SET blocking_reviews = ?2 WHERE id = ?1')
    .bind(id, on ? 1 : 0)
    .run();
}

export async function setRepoAutoFix(id: number, on: boolean): Promise<void> {
  await env.DB.prepare('UPDATE repositories SET auto_fix = ?2 WHERE id = ?1')
    .bind(id, on ? 1 : 0)
    .run();
}

export async function setRepoAutoMerge(id: number, on: boolean): Promise<void> {
  await env.DB.prepare('UPDATE repositories SET auto_merge = ?2 WHERE id = ?1')
    .bind(id, on ? 1 : 0)
    .run();
}

export async function setRepoAutoResolveConflicts(id: number, on: boolean): Promise<void> {
  await env.DB.prepare('UPDATE repositories SET auto_resolve_conflicts = ?2 WHERE id = ?1')
    .bind(id, on ? 1 : 0)
    .run();
}

// The sandbox verification gate for factory pushes. Empty string clears it.
export async function setRepoLaunchable(id: number, launchable: boolean): Promise<void> {
  await env.DB.prepare('UPDATE repositories SET launchable = ?2 WHERE id = ?1')
    .bind(id, launchable ? 1 : 0)
    .run();
}

export async function setRepoDemoVideos(id: number, on: boolean): Promise<void> {
  await env.DB.prepare('UPDATE repositories SET demo_videos = ?2 WHERE id = ?1')
    .bind(id, on ? 1 : 0)
    .run();
}

export async function setRepoCheckCommand(id: number, command: string): Promise<void> {
  const trimmed = command.trim();
  await env.DB.prepare('UPDATE repositories SET check_command = ?2 WHERE id = ?1')
    .bind(id, trimmed || null)
    .run();
}

// How the verify step launches the repo's app for runtime/visual checks.
// Empty command clears both fields (static verification only).
export async function setRepoRunCommand(
  id: number,
  command: string,
  port: number | null,
): Promise<void> {
  const trimmed = command.trim();
  await env.DB.prepare('UPDATE repositories SET run_command = ?2, app_port = ?3 WHERE id = ?1')
    .bind(id, trimmed || null, trimmed ? port : null)
    .run();
}
