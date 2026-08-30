import { sql } from 'drizzle-orm';
import type { CrFileChange } from '../ai/runtime/cr-engine.ts';
import { changeProviderKey, upsertChange } from './changes.ts';
import { execute, queryOne, queryRows, withTransaction } from './database.ts';

// Typed layer over the native change-request store (docs/artifacts-provider.md).
// Diff patches live in R2 under the private
// crs/ prefix; only their keys are recorded here.

export interface ChangeRequestRow {
  id: number;
  repository_id: number;
  number: number;
  feature_id: number | null;
  change_id: number | null;
  title: string;
  source_branch: string;
  target_branch: string;
  status: string; // 'open' | 'merged' | 'closed'
  source_head: string | null;
  target_head: string | null;
  merge_base: string | null;
  mergeable: boolean | null;
  conflict_files: string[] | null;
  files: CrFileChange[] | null;
  diff_key: string | null;
  patch_truncated: boolean;
  review_status: string | null; // 'approved' | 'changes_requested'
  merged_head: string | null;
  opened_by: string;
  created_at: string;
  updated_at: string;
}

export interface CrCommentRow {
  id: number;
  change_request_id: number;
  file: string | null;
  line: number | null;
  author: string;
  kind: string; // 'comment' | 'finding' | 'summary'
  severity: string | null;
  body: string;
  created_at: string;
}

export interface CrCheckRow {
  id: number;
  change_request_id: number;
  name: string; // 'check' | 'review' | 'verify'
  status: string; // 'running' | 'passed' | 'failed' | 'error'
  summary: string | null;
  created_at: string;
  updated_at: string;
}

export async function createChangeRequest(input: {
  repositoryId: number;
  featureId: number | null;
  title: string;
  sourceBranch: string;
  targetBranch: string;
  openedBy: string;
}): Promise<ChangeRequestRow> {
  // The counter row is incremented atomically, so concurrent creators never
  // allocate the same per-repository display number. The canonical Change,
  // native extension row, and optional feature link commit together.
  return withTransaction(async () => {
    const row = await queryOne<ChangeRequestRow>(sql`
      INSERT INTO app.change_requests
        (repository_id, number, feature_id, title, source_branch, target_branch, opened_by)
      VALUES (
        ${input.repositoryId}, app.next_change_request_number(${input.repositoryId}),
        ${input.featureId}, ${input.title}, ${input.sourceBranch}, ${input.targetBranch},
        ${input.openedBy}
      )
      RETURNING *
    `);
    if (!row) throw new Error('change request insert returned no row');

    const change = await upsertChange({
      repositoryId: input.repositoryId,
      providerKey: changeProviderKey('artifacts', row.number),
      number: row.number,
      origin: input.openedBy === 'factory' ? 'factory' : 'human',
      title: input.title,
      externalUrl: null,
      sourceBranch: input.sourceBranch,
      targetBranch: input.targetBranch,
      status: 'open',
      sourceHead: null,
      targetHead: null,
      draft: false,
      capabilities: ['read_change', 'publish_review', 'write_head', 'publish_check', 'merge'],
    });
    await execute(sql`
      UPDATE app.change_requests SET change_id = ${change.id} WHERE id = ${row.id}
    `);
    if (input.featureId !== null) {
      await execute(sql`
        UPDATE app.features SET change_id = ${change.id} WHERE id = ${input.featureId}
      `);
    }
    return { ...row, change_id: change.id };
  });
}

export async function getChangeRequest(id: number): Promise<ChangeRequestRow | null> {
  return queryOne<ChangeRequestRow>(sql`SELECT * FROM app.change_requests WHERE id = ${id}`);
}

export async function getChangeRequestByRepoNumber(
  repositoryId: number,
  number: number,
): Promise<ChangeRequestRow | null> {
  return queryOne<ChangeRequestRow>(sql`
    SELECT * FROM app.change_requests
    WHERE repository_id = ${repositoryId} AND number = ${number}
  `);
}

export async function getChangeRequestByChangeId(
  changeId: number,
): Promise<ChangeRequestRow | null> {
  return queryOne<ChangeRequestRow>(sql`
    SELECT * FROM app.change_requests WHERE change_id = ${changeId}
  `);
}

export async function getOpenChangeRequest(
  repositoryId: number,
  sourceBranch: string,
  targetBranch: string,
): Promise<ChangeRequestRow | null> {
  return queryOne<ChangeRequestRow>(sql`
    SELECT * FROM app.change_requests
    WHERE repository_id = ${repositoryId} AND source_branch = ${sourceBranch}
      AND target_branch = ${targetBranch} AND status = 'open'
  `);
}

export async function listChangeRequestsForRepo(
  repositoryId: number,
  status?: string,
): Promise<ChangeRequestRow[]> {
  const statusFilter = status ? sql`AND status = ${status}` : sql.empty();
  return queryRows<ChangeRequestRow>(sql`
    SELECT * FROM app.change_requests
    WHERE repository_id = ${repositoryId} ${statusFilter}
    ORDER BY number DESC
  `);
}

export interface ChangeRequestStatePatch {
  sourceHead: string;
  targetHead: string;
  mergeBase: string;
  mergeable: boolean;
  conflictFiles: string[];
  files: CrFileChange[];
  diffKey: string;
  patchTruncated: boolean;
}

// The engine's recompute result, applied atomically.
export async function updateChangeRequestState(
  id: number,
  state: ChangeRequestStatePatch,
): Promise<void> {
  await withTransaction(async () => {
    await execute(sql`
      UPDATE app.change_requests SET
        source_head = ${state.sourceHead}, target_head = ${state.targetHead},
        merge_base = ${state.mergeBase}, mergeable = ${state.mergeable},
        conflict_files = ${JSON.stringify(state.conflictFiles)}::jsonb,
        files = ${JSON.stringify(state.files)}::jsonb, diff_key = ${state.diffKey},
        patch_truncated = ${state.patchTruncated}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ${id}
    `);
    await execute(sql`
      UPDATE app.changes SET source_head = ${state.sourceHead}, target_head = ${state.targetHead},
        updated_at = CURRENT_TIMESTAMP
      WHERE id = (SELECT change_id FROM app.change_requests WHERE id = ${id})
    `);
  });
}

export async function setChangeRequestReviewStatus(
  id: number,
  reviewStatus: 'approved' | 'changes_requested',
): Promise<void> {
  await execute(sql`
    UPDATE app.change_requests SET review_status = ${reviewStatus} WHERE id = ${id}
  `);
}

export async function markChangeRequestMerged(id: number, mergedHead: string): Promise<void> {
  await withTransaction(async () => {
    await execute(sql`
      UPDATE app.change_requests SET status = 'merged', merged_head = ${mergedHead},
        mergeable = TRUE, conflict_files = '[]'::jsonb, updated_at = CURRENT_TIMESTAMP
      WHERE id = ${id}
    `);
    await execute(sql`
      UPDATE app.changes SET status = 'merged', target_head = ${mergedHead},
        updated_at = CURRENT_TIMESTAMP
      WHERE id = (SELECT change_id FROM app.change_requests WHERE id = ${id})
    `);
  });
}

export async function closeChangeRequest(id: number): Promise<void> {
  await withTransaction(async () => {
    await execute(sql`
      UPDATE app.change_requests SET status = 'closed', updated_at = CURRENT_TIMESTAMP WHERE id = ${id}
    `);
    await execute(sql`
      UPDATE app.changes SET status = 'closed', updated_at = CURRENT_TIMESTAMP
      WHERE id = (SELECT change_id FROM app.change_requests WHERE id = ${id})
    `);
  });
}

export async function addCrComment(input: {
  changeRequestId: number;
  file: string | null;
  line: number | null;
  author: string;
  kind: 'comment' | 'finding' | 'summary';
  severity: string | null;
  body: string;
}): Promise<CrCommentRow> {
  const row = await queryOne<CrCommentRow>(sql`
    INSERT INTO app.cr_comments (change_request_id, file, line, author, kind, severity, body)
    VALUES (
      ${input.changeRequestId}, ${input.file}, ${input.line}, ${input.author},
      ${input.kind}, ${input.severity}, ${input.body}
    )
    RETURNING *
  `);
  if (!row) throw new Error('cr comment insert returned no row');
  return row;
}

export async function listCrComments(changeRequestId: number): Promise<CrCommentRow[]> {
  return queryRows<CrCommentRow>(sql`
    SELECT * FROM app.cr_comments WHERE change_request_id = ${changeRequestId} ORDER BY id
  `);
}

export async function upsertCrCheck(
  changeRequestId: number,
  name: 'check' | 'review' | 'verify',
  status: 'running' | 'passed' | 'failed' | 'error',
  summary?: string,
): Promise<void> {
  await execute(sql`
    INSERT INTO app.cr_checks (change_request_id, name, status, summary)
    VALUES (${changeRequestId}, ${name}, ${status}, ${summary ?? null})
    ON CONFLICT (change_request_id, name) DO UPDATE SET
      status = EXCLUDED.status, summary = EXCLUDED.summary
  `);
}

export async function listCrChecks(changeRequestId: number): Promise<CrCheckRow[]> {
  return queryRows<CrCheckRow>(sql`
    SELECT * FROM app.cr_checks WHERE change_request_id = ${changeRequestId} ORDER BY name
  `);
}
