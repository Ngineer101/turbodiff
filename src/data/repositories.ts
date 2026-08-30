import { inArray, sql } from 'drizzle-orm';
import { execute, queryOne, queryRows, withDatabase, withTransaction } from './database.ts';
import { repositories } from './schema.ts';
import { bigintArray } from './sql.ts';
import type { ReviewIntakeMode } from '../domain/review-intake.ts';
import type { ProcessProfileKey } from '../domain/lifecycle-contract.ts';
import type { AdoptableProcessProfileKey } from '../domain/process-profiles.ts';

// Thin typed layer over the PostgreSQL application schema.

export interface InstallationRow {
  id: number;
  account_login: string;
  account_id: number;
  account_type: string;
  suspended: boolean;
  provider: string; // 'github' | 'artifacts' (synthetic tenancy rows)
  installer_github_id: number | null; // App installer (webhook sender); feeds the deferred owner bootstrap
}

export interface RepositoryRow {
  id: number;
  installation_id: number;
  owner: string;
  name: string;
  provider: string; // 'github' | 'artifacts'
  artifacts_repo: string | null; // repo name in turbodiff's Artifacts namespace
  default_branch: string | null; // stored for Artifacts repos; NULL for GitHub
  last_push_at: string | null; // maintained by Artifacts event ingestion
  enabled: boolean;
  review_on_push: boolean; // re-dispatch tiered agents on pushes to open PRs
  review_intake: ReviewIntakeMode;
  process_profile: ProcessProfileKey;
  blocking_reviews: boolean; // P1 → REQUEST_CHANGES, clean → APPROVE
  auto_fix: boolean; // dispatch the fix agent when a blocking review lands
  auto_merge: boolean; // merge factory PRs when verification + review are clean
  auto_resolve_conflicts: boolean; // dispatch the fix agent to resolve a merge conflict
  demo_videos: boolean; // record a verification demo video (runtime auto-detected)
  launchable: boolean | null; // cached detection: null unknown
  check_command: string | null; // sandbox verification gate before factory pushes
  run_command: string | null; // how to launch the app for runtime verification
  app_port: number | null; // port the launched app listens on
  model: string | null;
  created_at: string; // when the repo was connected
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

export async function upsertInstallation(
  id: number,
  account: WebhookAccount,
  installerGithubId?: number,
): Promise<void> {
  // COALESCE keeps a recorded installer through deliveries that carry no
  // sender (installation_repositories) — only the `installation created`
  // delivery may set it. A reinstall receives a new installation id; remove
  // a stale row for the same GitHub account first so the provider/account
  // uniqueness constraints cannot permanently reject webhook retries.
  await withTransaction(async (transaction) => {
    await transaction.execute(sql`
        DELETE FROM app.installations
        WHERE provider = 'github' AND id <> ${id}
          AND (account_id = ${account.id} OR account_login = ${account.login})
      `);
    await transaction.execute(sql`
        INSERT INTO app.installations
          (id, account_login, account_id, account_type, suspended, installer_github_id)
        VALUES (
          ${id}, ${account.login}, ${account.id}, ${account.type}, FALSE, ${installerGithubId ?? null}
        )
        ON CONFLICT(id) DO UPDATE SET
          account_login = excluded.account_login,
          account_id = excluded.account_id,
          account_type = excluded.account_type,
          suspended = FALSE,
          installer_github_id = COALESCE(
            excluded.installer_github_id,
            installations.installer_github_id
          )
      `);
  });
}

export async function deleteInstallation(id: number): Promise<void> {
  await execute(sql`DELETE FROM app.installations WHERE id = ${id}`);
}

export async function setInstallationSuspended(id: number, suspended: boolean): Promise<void> {
  await execute(sql`
    UPDATE app.installations SET suspended = ${suspended} WHERE id = ${id}
  `);
}

export async function addRepositories(installationId: number, repos: WebhookRepo[]): Promise<void> {
  if (repos.length === 0) return;
  await withDatabase(async (database) => {
    await database
      .insert(repositories)
      .values(
        repos.map((repo) => {
          const [owner = '', name = ''] = repo.full_name.split('/');
          return { id: repo.id, installationId, owner, name };
        }),
      )
      .onConflictDoUpdate({
        target: repositories.id,
        set: {
          installationId: sql`excluded.installation_id`,
          owner: sql`excluded.owner`,
          name: sql`excluded.name`,
        },
      });
  });
}

export async function listRepositoryIdsForInstallation(installationId: number): Promise<number[]> {
  const rows = await queryRows<{ id: number }>(sql`
    SELECT id FROM app.repositories WHERE installation_id = ${installationId}
  `);
  return rows.map((row) => row.id);
}

export async function removeRepositories(repoIds: number[]): Promise<void> {
  if (repoIds.length === 0) return;
  await withDatabase(async (database) => {
    await database.delete(repositories).where(inArray(repositories.id, repoIds));
  });
}

export async function getRepoByFullName(
  owner: string,
  name: string,
): Promise<RepositoryRow | null> {
  return queryOne<RepositoryRow>(sql`
    SELECT * FROM app.repositories WHERE owner = ${owner} AND name = ${name}
  `);
}

export async function getInstallation(id: number): Promise<InstallationRow | null> {
  return queryOne<InstallationRow>(sql`SELECT * FROM app.installations WHERE id = ${id}`);
}

// ── Artifacts-hosted projects (docs/artifacts-provider.md) ─────────────────
// Artifacts rows reuse the installation-scoped access model. A dedicated
// high-range sequence allocates collision-free ids without the old MIN(id)-1
// scan/race or overloaded negative-id convention.

export async function getArtifactsInstallationByLogin(
  accountLogin: string,
): Promise<InstallationRow | null> {
  return queryOne<InstallationRow>(sql`
    SELECT * FROM app.installations
    WHERE account_login = ${accountLogin} AND provider = 'artifacts'
  `);
}

export async function createArtifactsInstallation(accountLogin: string): Promise<InstallationRow> {
  const row = await queryOne<InstallationRow>(sql`
    WITH allocated AS (SELECT nextval('app.native_entity_id_seq') AS id)
    INSERT INTO app.installations (id, account_login, account_id, account_type, provider)
    SELECT id, ${accountLogin}, id, 'Organization', 'artifacts' FROM allocated
    RETURNING *
  `);
  if (!row) throw new Error('artifacts installation insert returned no row');
  return row;
}

export async function createArtifactsRepository(input: {
  installationId: number;
  owner: string;
  name: string;
  artifactsRepo: string;
  defaultBranch: string;
}): Promise<RepositoryRow> {
  const row = await queryOne<RepositoryRow>(sql`
    INSERT INTO app.repositories
      (installation_id, owner, name, provider, artifacts_repo, default_branch)
    VALUES (
      ${input.installationId}, ${input.owner}, ${input.name},
      'artifacts', ${input.artifactsRepo}, ${input.defaultBranch}
    )
    RETURNING *
  `);
  if (!row) throw new Error('artifacts repository insert returned no row');
  return row;
}

export async function getRepoByArtifactsName(artifactsRepo: string): Promise<RepositoryRow | null> {
  return queryOne<RepositoryRow>(sql`
    SELECT * FROM app.repositories WHERE artifacts_repo = ${artifactsRepo}
  `);
}

export async function recordArtifactsPush(
  artifactsRepo: string,
  pushedAt: string,
): Promise<RepositoryRow | null> {
  return queryOne<RepositoryRow>(sql`
    UPDATE app.repositories SET last_push_at = ${pushedAt}
    WHERE artifacts_repo = ${artifactsRepo}
    RETURNING *
  `);
}

export async function listInstallationsWithRepos(
  installationIds: number[],
): Promise<{ installation: InstallationRow; repos: RepositoryRow[] }[]> {
  if (installationIds.length === 0) return [];
  const [installations, repos] = await Promise.all([
    queryRows<InstallationRow>(sql`
      SELECT * FROM app.installations
      WHERE id = ANY(${bigintArray(installationIds)})
      ORDER BY account_login
    `),
    queryRows<RepositoryRow>(sql`
      SELECT * FROM app.repositories
      WHERE installation_id = ANY(${bigintArray(installationIds)})
      ORDER BY owner, name
    `),
  ]);
  return installations.map((installation) => ({
    installation,
    repos: repos.filter((repo) => repo.installation_id === installation.id),
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
  return queryRows<OrgMemberRow>(sql`
    SELECT member.id, "user".login, "user".email,
      member.role, member."createdAt" AS created_at
    FROM auth."member" AS member
    JOIN auth."user" AS "user" ON "user".id = member."userId"
    WHERE member."organizationId" = ${organizationId}
    ORDER BY member."createdAt"
  `);
}

export async function listPendingInvitations(organizationId: string): Promise<OrgInvitationRow[]> {
  return queryRows<OrgInvitationRow>(sql`
    SELECT id, email, role, status, "expiresAt" AS expires_at
    FROM auth."invitation"
    WHERE "organizationId" = ${organizationId} AND status = 'pending'
    ORDER BY "createdAt"
  `);
}

export async function getRepoById(id: number): Promise<RepositoryRow | null> {
  return queryOne<RepositoryRow>(sql`SELECT * FROM app.repositories WHERE id = ${id}`);
}

export async function setRepoEnabled(id: number, enabled: boolean): Promise<void> {
  await execute(sql`UPDATE app.repositories SET enabled = ${enabled} WHERE id = ${id}`);
}

export async function setRepoReviewOnPush(id: number, on: boolean): Promise<void> {
  await execute(sql`UPDATE app.repositories SET review_on_push = ${on} WHERE id = ${id}`);
}

export async function setRepoReviewIntake(id: number, mode: ReviewIntakeMode): Promise<void> {
  const profile =
    mode === 'on_demand'
      ? 'review_on_demand'
      : mode === 'all_changes'
        ? 'automatic_review'
        : 'legacy_factory';
  await execute(sql`
    UPDATE app.repositories SET review_intake = ${mode}, process_profile = ${profile}
    WHERE id = ${id}
  `);
}

export async function setRepoProcessProfile(
  id: number,
  profile: AdoptableProcessProfileKey,
): Promise<void> {
  const intake: ReviewIntakeMode =
    profile === 'legacy_factory'
      ? 'factory_only'
      : profile === 'review_on_demand' || profile === 'idea_to_pr'
        ? 'on_demand'
        : 'all_changes';
  await execute(sql`
    UPDATE app.repositories SET process_profile = ${profile}, review_intake = ${intake}
    WHERE id = ${id}
  `);
}

export async function setRepoBlockingReviews(id: number, on: boolean): Promise<void> {
  await execute(sql`UPDATE app.repositories SET blocking_reviews = ${on} WHERE id = ${id}`);
}

export async function setRepoAutoFix(id: number, on: boolean): Promise<void> {
  await execute(sql`UPDATE app.repositories SET auto_fix = ${on} WHERE id = ${id}`);
}

export async function setRepoAutoMerge(id: number, on: boolean): Promise<void> {
  await execute(sql`UPDATE app.repositories SET auto_merge = ${on} WHERE id = ${id}`);
}

export async function setRepoAutoResolveConflicts(id: number, on: boolean): Promise<void> {
  await execute(sql`
    UPDATE app.repositories SET auto_resolve_conflicts = ${on} WHERE id = ${id}
  `);
}

// The sandbox verification gate for factory pushes. Empty string clears it.
export async function setRepoLaunchable(id: number, launchable: boolean): Promise<void> {
  await execute(sql`
    UPDATE app.repositories SET launchable = ${launchable} WHERE id = ${id}
  `);
}

export async function setRepoDemoVideos(id: number, on: boolean): Promise<void> {
  await execute(sql`UPDATE app.repositories SET demo_videos = ${on} WHERE id = ${id}`);
}

export async function setRepoCheckCommand(id: number, command: string): Promise<void> {
  const trimmed = command.trim();
  await execute(sql`
    UPDATE app.repositories SET check_command = ${trimmed || null} WHERE id = ${id}
  `);
}

// How the verify step launches the repo's app for runtime/visual checks.
// Empty command clears both fields (static verification only).
export async function setRepoRunCommand(
  id: number,
  command: string,
  port: number | null,
): Promise<void> {
  const trimmed = command.trim();
  await execute(sql`
    UPDATE app.repositories
    SET run_command = ${trimmed || null}, app_port = ${trimmed ? port : null}
    WHERE id = ${id}
  `);
}
