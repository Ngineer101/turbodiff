import { database } from './postgres.ts';
import { isJsonArray, isNumber, parseJson } from '../shared/json.ts';

export interface InstallationAccessSnapshot {
  installationIds: number[];
  verifiedAt: number;
}

export async function installationAccessSnapshot(
  userId: string,
): Promise<InstallationAccessSnapshot | null> {
  const row = await database()
    .prepare(
      'SELECT installation_ids, verified_at FROM user_installation_access WHERE user_id = ?1',
    )
    .bind(userId)
    .first<{ installation_ids: string; verified_at: string }>();
  if (!row) return null;
  let parsed;
  try {
    parsed = parseJson(row.installation_ids);
  } catch {
    return null;
  }
  if (!isJsonArray(parsed)) return null;
  const installationIds = parsed.filter(isNumber);
  if (installationIds.length !== parsed.length || !installationIds.every(Number.isInteger)) {
    return null;
  }
  const verifiedAt = Date.parse(row.verified_at);
  if (!Number.isFinite(verifiedAt)) return null;
  return { installationIds, verifiedAt };
}

export async function storeInstallationAccessSnapshot(
  userId: string,
  installationIds: number[],
): Promise<void> {
  await database()
    .prepare(
      `INSERT INTO user_installation_access (user_id, installation_ids, verified_at)
		 VALUES (?1, ?2, CURRENT_TIMESTAMP)
		 ON CONFLICT(user_id) DO UPDATE SET installation_ids = ?2, verified_at = CURRENT_TIMESTAMP`,
    )
    .bind(userId, installationIds)
    .run();
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
  await database()
    .prepare(
      `INSERT INTO repository_refs (repository_id, ref, head_sha, pushed_at)
		 VALUES (?1, ?2, ?3, ?4)
		 ON CONFLICT(repository_id, ref)
		 DO UPDATE SET head_sha = ?3, pushed_at = ?4`,
    )
    .bind(repositoryId, ref, headSha, pushedAt)
    .run();
}

export async function deleteRepositoryRef(repositoryId: number, ref: string): Promise<void> {
  await database()
    .prepare('DELETE FROM repository_refs WHERE repository_id = ?1 AND ref = ?2')
    .bind(repositoryId, ref)
    .run();
}

export async function repositoryRef(
  repositoryId: number,
  ref: string,
): Promise<RepositoryRefRow | null> {
  return database()
    .prepare('SELECT * FROM repository_refs WHERE repository_id = ?1 AND ref = ?2')
    .bind(repositoryId, ref)
    .first<RepositoryRefRow>();
}

export async function repositoryRefs(repositoryId: number): Promise<RepositoryRefRow[]> {
  const rows = await database()
    .prepare('SELECT * FROM repository_refs WHERE repository_id = ?1 ORDER BY ref')
    .bind(repositoryId)
    .all<RepositoryRefRow>();
  return rows.results;
}

export async function claimInstallationRepoSync(
  installationId: number,
  intervalMinutes = 5,
): Promise<boolean> {
  const row = await database()
    .prepare(
      `INSERT INTO installation_repo_sync (installation_id, syncing_until)
		 VALUES (?1, CURRENT_TIMESTAMP + INTERVAL '5 minutes')
		 ON CONFLICT(installation_id) DO UPDATE
		 SET syncing_until = CURRENT_TIMESTAMP + INTERVAL '5 minutes'
		 WHERE (syncing_until IS NULL OR syncing_until < CURRENT_TIMESTAMP)
		   AND (last_synced_at IS NULL OR last_synced_at < CURRENT_TIMESTAMP - (?2::double precision * INTERVAL '1 minute'))
		 RETURNING installation_id`,
    )
    .bind(installationId, intervalMinutes)
    .first<{ installation_id: number }>();
  return row !== null;
}

export async function finishInstallationRepoSync(
  installationId: number,
  success: boolean,
): Promise<void> {
  await database()
    .prepare(
      success
        ? `UPDATE installation_repo_sync
		   SET last_synced_at = CURRENT_TIMESTAMP, syncing_until = NULL
		   WHERE installation_id = ?1`
        : `UPDATE installation_repo_sync SET syncing_until = NULL WHERE installation_id = ?1`,
    )
    .bind(installationId)
    .run();
}
