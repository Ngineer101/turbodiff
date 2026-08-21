import { env } from 'cloudflare:workers';

// Typed layer over the native change-request store (migration 0036,
// docs/artifacts-provider.md). Diff patches live in R2 under the private
// crs/ prefix; only their keys are recorded here.

export interface ChangeRequestRow {
  id: number;
  repository_id: number;
  number: number;
  feature_id: number | null;
  title: string;
  source_branch: string;
  target_branch: string;
  status: string; // 'open' | 'merged' | 'closed'
  source_head: string | null;
  target_head: string | null;
  merge_base: string | null;
  mergeable: number | null; // NULL unknown, 1 clean, 0 conflicts
  conflict_files: string | null; // JSON string[]
  files: string | null; // JSON CrFileChange[]
  diff_key: string | null;
  patch_truncated: number;
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
  // Per-repo display number allocated in the INSERT itself so no read can
  // race the sequence.
  const row = await env.DB.prepare(
    `INSERT INTO change_requests
		   (repository_id, number, feature_id, title, source_branch, target_branch, opened_by)
		 SELECT ?1, COALESCE(MAX(number), 0) + 1, ?2, ?3, ?4, ?5, ?6
		 FROM change_requests WHERE repository_id = ?1
		 RETURNING *`,
  )
    .bind(
      input.repositoryId,
      input.featureId,
      input.title,
      input.sourceBranch,
      input.targetBranch,
      input.openedBy,
    )
    .first<ChangeRequestRow>();
  if (!row) throw new Error('change request insert returned no row');
  return row;
}

export async function getChangeRequest(id: number): Promise<ChangeRequestRow | null> {
  return env.DB.prepare('SELECT * FROM change_requests WHERE id = ?1')
    .bind(id)
    .first<ChangeRequestRow>();
}

export async function getOpenChangeRequest(
  repositoryId: number,
  sourceBranch: string,
  targetBranch: string,
): Promise<ChangeRequestRow | null> {
  return env.DB.prepare(
    `SELECT * FROM change_requests
		 WHERE repository_id = ?1 AND source_branch = ?2 AND target_branch = ?3 AND status = 'open'`,
  )
    .bind(repositoryId, sourceBranch, targetBranch)
    .first<ChangeRequestRow>();
}

export async function listChangeRequestsForRepo(
  repositoryId: number,
  status?: string,
): Promise<ChangeRequestRow[]> {
  const rows = status
    ? await env.DB.prepare(
        'SELECT * FROM change_requests WHERE repository_id = ?1 AND status = ?2 ORDER BY number DESC',
      )
        .bind(repositoryId, status)
        .all<ChangeRequestRow>()
    : await env.DB.prepare(
        'SELECT * FROM change_requests WHERE repository_id = ?1 ORDER BY number DESC',
      )
        .bind(repositoryId)
        .all<ChangeRequestRow>();
  return rows.results;
}

export interface ChangeRequestStatePatch {
  sourceHead: string;
  targetHead: string;
  mergeBase: string;
  mergeable: boolean;
  conflictFiles: string[];
  filesJson: string;
  diffKey: string;
  patchTruncated: boolean;
}

// The engine's recompute result, applied atomically.
export async function updateChangeRequestState(
  id: number,
  state: ChangeRequestStatePatch,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE change_requests SET
		   source_head = ?2, target_head = ?3, merge_base = ?4, mergeable = ?5,
		   conflict_files = ?6, files = ?7, diff_key = ?8, patch_truncated = ?9,
		   updated_at = datetime('now')
		 WHERE id = ?1`,
  )
    .bind(
      id,
      state.sourceHead,
      state.targetHead,
      state.mergeBase,
      state.mergeable ? 1 : 0,
      JSON.stringify(state.conflictFiles),
      state.filesJson,
      state.diffKey,
      state.patchTruncated ? 1 : 0,
    )
    .run();
}

export async function setChangeRequestReviewStatus(
  id: number,
  reviewStatus: 'approved' | 'changes_requested',
): Promise<void> {
  await env.DB.prepare(
    `UPDATE change_requests SET review_status = ?2, updated_at = datetime('now') WHERE id = ?1`,
  )
    .bind(id, reviewStatus)
    .run();
}

export async function markChangeRequestMerged(id: number, mergedHead: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE change_requests SET status = 'merged', merged_head = ?2, mergeable = 1,
		   conflict_files = '[]', updated_at = datetime('now')
		 WHERE id = ?1`,
  )
    .bind(id, mergedHead)
    .run();
}

export async function closeChangeRequest(id: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE change_requests SET status = 'closed', updated_at = datetime('now') WHERE id = ?1`,
  )
    .bind(id)
    .run();
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
  const row = await env.DB.prepare(
    `INSERT INTO cr_comments (change_request_id, file, line, author, kind, severity, body)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
		 RETURNING *`,
  )
    .bind(
      input.changeRequestId,
      input.file,
      input.line,
      input.author,
      input.kind,
      input.severity,
      input.body,
    )
    .first<CrCommentRow>();
  if (!row) throw new Error('cr comment insert returned no row');
  return row;
}

export async function listCrComments(changeRequestId: number): Promise<CrCommentRow[]> {
  const rows = await env.DB.prepare(
    'SELECT * FROM cr_comments WHERE change_request_id = ?1 ORDER BY id',
  )
    .bind(changeRequestId)
    .all<CrCommentRow>();
  return rows.results;
}

export async function upsertCrCheck(
  changeRequestId: number,
  name: 'check' | 'review' | 'verify',
  status: 'running' | 'passed' | 'failed' | 'error',
  summary?: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO cr_checks (change_request_id, name, status, summary)
		 VALUES (?1, ?2, ?3, ?4)
		 ON CONFLICT (change_request_id, name) DO UPDATE SET
		   status = ?3, summary = ?4, updated_at = datetime('now')`,
  )
    .bind(changeRequestId, name, status, summary ?? null)
    .run();
}

export async function listCrChecks(changeRequestId: number): Promise<CrCheckRow[]> {
  const rows = await env.DB.prepare(
    'SELECT * FROM cr_checks WHERE change_request_id = ?1 ORDER BY name',
  )
    .bind(changeRequestId)
    .all<CrCheckRow>();
  return rows.results;
}
