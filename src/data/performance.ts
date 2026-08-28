import { eq, sql } from 'drizzle-orm';
import { execute, queryOne, queryRows, withDatabase } from './database.ts';
import { userInstallationAccess } from './schema.ts';

export interface InstallationAccessSnapshot {
  installationIds: number[];
  verifiedAt: number;
}

export async function installationAccessSnapshot(
  userId: string,
): Promise<InstallationAccessSnapshot | null> {
  const row = await withDatabase(async (database) => {
    const rows = await database
      .select({
        installationIds: userInstallationAccess.installationIds,
        verifiedAt: userInstallationAccess.verifiedAt,
      })
      .from(userInstallationAccess)
      .where(eq(userInstallationAccess.userId, userId))
      .limit(1);
    return rows[0] ?? null;
  });
  if (!row) return null;
  if (!row.installationIds.every(Number.isInteger)) {
    return null;
  }
  const verifiedAt = Date.parse(row.verifiedAt);
  if (!Number.isFinite(verifiedAt)) return null;
  return { installationIds: row.installationIds, verifiedAt };
}

export async function storeInstallationAccessSnapshot(
  userId: string,
  installationIds: number[],
): Promise<void> {
  await withDatabase(async (database) => {
    await database
      .insert(userInstallationAccess)
      .values({ userId, installationIds })
      .onConflictDoUpdate({
        target: userInstallationAccess.userId,
        set: { installationIds, verifiedAt: sql`CURRENT_TIMESTAMP` },
      });
  });
}

export interface RepositoryRefRow {
  repository_id: number;
  ref: string;
  head_sha: string;
  pushed_at: string;
}

export async function recordRepositoryRef(
  repositoryId: number,
  ref: string,
  headSha: string,
  pushedAt: string,
): Promise<void> {
  await execute(sql`
    INSERT INTO app.repository_refs (repository_id, ref, head_sha, pushed_at)
    VALUES (${repositoryId}, ${ref}, ${headSha}, ${pushedAt})
    ON CONFLICT(repository_id, ref)
    DO UPDATE SET head_sha = ${headSha}, pushed_at = ${pushedAt}
  `);
}

export async function deleteRepositoryRef(repositoryId: number, ref: string): Promise<void> {
  await execute(sql`
    DELETE FROM app.repository_refs WHERE repository_id = ${repositoryId} AND ref = ${ref}
  `);
}

export async function repositoryRef(
  repositoryId: number,
  ref: string,
): Promise<RepositoryRefRow | null> {
  return queryOne<RepositoryRefRow>(sql`
    SELECT * FROM app.repository_refs WHERE repository_id = ${repositoryId} AND ref = ${ref}
  `);
}

export async function repositoryRefs(repositoryId: number): Promise<RepositoryRefRow[]> {
  return queryRows<RepositoryRefRow>(sql`
    SELECT * FROM app.repository_refs WHERE repository_id = ${repositoryId} ORDER BY ref
  `);
}

export async function claimInstallationRepoSync(
  installationId: number,
  intervalMinutes = 5,
): Promise<boolean> {
  const row = await queryOne<{ installation_id: number }>(sql`
    INSERT INTO app.installation_repo_sync (installation_id, syncing_until)
    VALUES (${installationId}, CURRENT_TIMESTAMP + INTERVAL '5 minutes')
    ON CONFLICT(installation_id) DO UPDATE
    SET syncing_until = CURRENT_TIMESTAMP + INTERVAL '5 minutes'
    WHERE (installation_repo_sync.syncing_until IS NULL
        OR installation_repo_sync.syncing_until < CURRENT_TIMESTAMP)
      AND (installation_repo_sync.last_synced_at IS NULL
        OR installation_repo_sync.last_synced_at
          < CURRENT_TIMESTAMP - (${intervalMinutes}::double precision * INTERVAL '1 minute'))
    RETURNING installation_id
  `);
  return row !== null;
}

export async function finishInstallationRepoSync(
  installationId: number,
  success: boolean,
): Promise<void> {
  const update = success
    ? sql`
        UPDATE app.installation_repo_sync
        SET last_synced_at = CURRENT_TIMESTAMP, syncing_until = NULL
        WHERE installation_id = ${installationId}
      `
    : sql`
        UPDATE app.installation_repo_sync
        SET syncing_until = NULL
        WHERE installation_id = ${installationId}
      `;
  await execute(update);
}
