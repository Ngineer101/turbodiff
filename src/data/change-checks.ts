import { sql } from 'drizzle-orm';
import { execute, queryRows } from './postgres.ts';
import type { ChangeRevisionRow } from './changes.ts';

export interface ChangeCheckRow {
  name: string;
  status: 'queued' | 'running' | 'completed';
  conclusion: string | null;
  details_url: string | null;
  updated_at: string;
}
export function listChangeChecks(revisionId: number): Promise<ChangeCheckRow[]> {
  return queryRows(
    sql`SELECT name, status, conclusion, details_url, updated_at FROM app.change_checks WHERE change_revision_id = ${revisionId} ORDER BY name`,
  );
}
export async function recordChangeCheck(
  revision: ChangeRevisionRow,
  check: ChangeCheckRow,
): Promise<void> {
  await execute(sql`
    INSERT INTO app.change_checks (change_revision_id, organization_id, name, status, conclusion, details_url, updated_at)
    VALUES (${revision.id}, ${revision.organization_id}, ${check.name}, ${check.status}, ${check.conclusion}, ${check.details_url}, ${check.updated_at}::timestamptz)
    ON CONFLICT(change_revision_id, name) DO UPDATE SET status = excluded.status,
      conclusion = excluded.conclusion, details_url = excluded.details_url, updated_at = excluded.updated_at
    WHERE change_checks.updated_at <= excluded.updated_at
  `);
}
