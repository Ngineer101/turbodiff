import { env } from 'cloudflare:workers';
import { placeholderList } from './sql.ts';
import { STALL_CUTOFF_MODIFIER } from '../shared/time.ts';
import type { CliUsage } from '../shared/usage.ts';
import type { RepositoryRow } from './repositories.ts';

// --- verifications (Phase 4: empirical acceptance-criteria checks) ---

export interface VerificationRow {
  id: number;
  feature_id: number;
  status: string;
  results: string | null;
  summary: string | null;
  demo: string | null; // JSON {"video": r2Key, "caption": string}
  error: string | null;
  created_at: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  model: string | null;
}

export interface CockpitCommentRow {
  id: number;
  feature_id: number;
  path: string;
  line: number;
  side: string;
  body: string;
  author: string;
  author_id: number | null; // null on rows predating attribution
  status: string;
  created_at: string;
  fix_attempt_id: number | null;
  fix_status: string | null; // the linked fix_attempts row's status, if any
  fix_commit_sha: string | null;
  fix_error: string | null;
}

export async function createCockpitComment(
  featureId: number,
  path: string,
  line: number,
  side: string,
  body: string,
  author: string,
  // GitHub user id completing the commenter's noreply identity, so the fix
  // commit this comment dispatches can carry them as git author.
  authorId?: number,
): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO cockpit_comments (feature_id, path, line, side, body, author, author_id)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) RETURNING id`,
  )
    .bind(featureId, path, line, side, body, author, authorId ?? null)
    .first<{ id: number }>();
  return row!.id;
}

// Atomically claims every open comment on a feature into one batch, so two
// concurrent Submit clicks can't both grab the same comment into two
// separate fix runs.
export async function dispatchOpenCockpitComments(featureId: number): Promise<CockpitCommentRow[]> {
  const res = await env.DB.prepare(
    `UPDATE cockpit_comments SET status = 'dispatched'
		 WHERE feature_id = ?1 AND status = 'open'
		 RETURNING *`,
  )
    .bind(featureId)
    .all<CockpitCommentRow>();
  return res.results;
}

export async function linkCommentsToFixAttempt(
  commentIds: number[],
  attemptId: number,
): Promise<void> {
  if (commentIds.length === 0) return;
  const placeholders = placeholderList(commentIds.length, 2);
  await env.DB.prepare(
    `UPDATE cockpit_comments SET fix_attempt_id = ?1 WHERE id IN (${placeholders})`,
  )
    .bind(attemptId, ...commentIds)
    .run();
}

export async function hasRunningFixAttempt(
  repositoryId: number,
  prNumber: number,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT id FROM fix_attempts WHERE repository_id = ?1 AND pr_number = ?2 AND status = 'running' LIMIT 1`,
  )
    .bind(repositoryId, prNumber)
    .first<{ id: number }>();
  return row !== null;
}

export async function listCockpitComments(featureId: number): Promise<CockpitCommentRow[]> {
  const res = await env.DB.prepare(
    `SELECT c.*, fa.status AS fix_status, fa.commit_sha AS fix_commit_sha, fa.error AS fix_error
		 FROM cockpit_comments c
		 LEFT JOIN fix_attempts fa ON fa.id = c.fix_attempt_id
		 WHERE c.feature_id = ?1 ORDER BY c.id`,
  )
    .bind(featureId)
    .all<CockpitCommentRow>();
  return res.results;
}

// --- multi-repo task/plan repo lists (migration 0024) ---

// Replaces a todo's repo list wholesale (delete-then-insert), so repeated
// calls with a different array simply replace the prior selection.
export async function setTodoRepositories(todoId: number, repositoryIds: number[]): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM todo_repositories WHERE todo_id = ?1').bind(todoId),
    ...repositoryIds.map((repoId, i) =>
      env.DB.prepare(
        'INSERT INTO todo_repositories (todo_id, repository_id, position) VALUES (?1, ?2, ?3)',
      ).bind(todoId, repoId, i),
    ),
  ]);
}

export async function listReposForTodo(todoId: number): Promise<RepositoryRow[]> {
  const res = await env.DB.prepare(
    `SELECT r.* FROM todo_repositories tr
		 JOIN repositories r ON r.id = tr.repository_id
		 WHERE tr.todo_id = ?1
		 ORDER BY tr.position`,
  )
    .bind(todoId)
    .all<RepositoryRow>();
  return res.results;
}

export interface TodoRepoRow {
  todo_id: number;
  repository_id: number;
  owner: string;
  name: string;
}

// Batched repo lists for the board's todo cards — one query for every todo
// instead of one per row.
export async function todoRepositoriesForTodos(todoIds: number[]): Promise<TodoRepoRow[]> {
  if (todoIds.length === 0) return [];
  const placeholders = placeholderList(todoIds.length);
  const res = await env.DB.prepare(
    `SELECT tr.todo_id, tr.repository_id, r.owner, r.name
		 FROM todo_repositories tr
		 JOIN repositories r ON r.id = tr.repository_id
		 WHERE tr.todo_id IN (${placeholders})
		 ORDER BY tr.todo_id, tr.position`,
  )
    .bind(...todoIds)
    .all<TodoRepoRow>();
  return res.results;
}

export async function listReposForPlan(planId: number): Promise<RepositoryRow[]> {
  const res = await env.DB.prepare(
    `SELECT r.* FROM plan_repositories pr
		 JOIN repositories r ON r.id = pr.repository_id
		 WHERE pr.plan_id = ?1
		 ORDER BY pr.position`,
  )
    .bind(planId)
    .all<RepositoryRow>();
  return res.results;
}

export interface TaskRepoStatusRow {
  plan_id: number;
  repository_id: number;
  owner: string;
  name: string;
  feature_id: number | null;
  feature_status: string | null;
  feature_error: string | null;
  pr_number: number | null;
  provider: string;
  verification_status: string | null;
  verification_results: string | null;
}

// One row per repo attached to each of the given plans — the board/task
// routes' per-repo status array. Independent of listPlansForInstallations /
// getPlanWithRepoById, which stay keyed to the primary repo only.
export async function getTaskRepoStatuses(planIds: number[]): Promise<TaskRepoStatusRow[]> {
  if (planIds.length === 0) return [];
  const placeholders = placeholderList(planIds.length);
  const res = await env.DB.prepare(
    `SELECT pr.plan_id, pr.repository_id, r.owner, r.name, r.provider,
		        f.id AS feature_id, f.status AS feature_status, f.error AS feature_error,
		        f.pr_number AS pr_number,
		        v.status AS verification_status, v.results AS verification_results
		 FROM plan_repositories pr
		 JOIN repositories r ON r.id = pr.repository_id
		 LEFT JOIN features f ON f.plan_id = pr.plan_id AND f.repository_id = pr.repository_id
		 LEFT JOIN verifications v ON v.id = (SELECT MAX(id) FROM verifications WHERE feature_id = f.id)
		 WHERE pr.plan_id IN (${placeholders})
		 ORDER BY pr.plan_id, pr.position`,
  )
    .bind(...planIds)
    .all<TaskRepoStatusRow>();
  return res.results;
}

// The feature a factory PR belongs to (null for human-authored PRs).
export async function getFeatureByRepoPr(
  repositoryId: number,
  prNumber: number,
): Promise<FeatureRow | null> {
  return env.DB.prepare(
    'SELECT * FROM features WHERE repository_id = ?1 AND pr_number = ?2 ORDER BY id DESC LIMIT 1',
  )
    .bind(repositoryId, prNumber)
    .first<FeatureRow>();
}

export async function latestVerificationForFeature(
  featureId: number,
): Promise<VerificationRow | null> {
  return env.DB.prepare(
    'SELECT * FROM verifications WHERE feature_id = ?1 ORDER BY id DESC LIMIT 1',
  )
    .bind(featureId)
    .first<VerificationRow>();
}

// Verification runs killed mid-flight (isolate death) never reach their
// error handler, stranding rows in 'running' and the UI in an endless poll.
// Lazy sweep from the read paths, like failStrandedGeneration.
const VERIFICATION_STRAND_MINUTES = 45;

export async function failStrandedVerifications(): Promise<number> {
  const res = await env.DB.prepare(
    `UPDATE verifications SET status = 'error',
		   error = 'verification run was killed before finishing — re-run it from the PR or wait for the next push'
		 WHERE status = 'running'
		   AND created_at < datetime('now', '-${VERIFICATION_STRAND_MINUTES} minutes')`,
  ).run();
  return res.meta.changes ?? 0;
}

export async function createVerification(featureId: number): Promise<number> {
  const row = await env.DB.prepare(
    'INSERT INTO verifications (feature_id) VALUES (?1) RETURNING id',
  )
    .bind(featureId)
    .first<{ id: number }>();
  return row!.id;
}

export async function finishVerification(
  id: number,
  status: string,
  fields: {
    results?: string;
    summary?: string;
    error?: string;
    demo?: string;
    usage?: CliUsage;
  } = {},
): Promise<void> {
  await env.DB.prepare(
    `UPDATE verifications SET
		 status = ?2, results = ?3, summary = ?4, error = ?5, demo = ?6,
		 input_tokens = ?7, output_tokens = ?8, cache_read_tokens = ?9, cache_write_tokens = ?10,
		 cost_usd = ?11, model = ?12
		 WHERE id = ?1`,
  )
    .bind(
      id,
      status,
      fields.results ?? null,
      fields.summary ?? null,
      fields.error ?? null,
      fields.demo ?? null,
      fields.usage?.inputTokens ?? 0,
      fields.usage?.outputTokens ?? 0,
      fields.usage?.cacheReadTokens ?? 0,
      fields.usage?.cacheWriteTokens ?? 0,
      fields.usage?.costUsd ?? 0,
      fields.usage?.model ?? null,
    )
    .run();
}

// The plan a factory feature came from (null for direct /internal/generate).
// Every plan-originated feature sets features.plan_id at creation, so this
// resolves correctly for every repo's feature in a multi-repo task — not
// just the primary repo's via the legacy plans.feature_id pointer.
export async function getPlanByFeatureId(featureId: number): Promise<PlanRow | null> {
  return env.DB.prepare(
    `SELECT p.* FROM plans p JOIN features f ON f.plan_id = p.id WHERE f.id = ?1`,
  )
    .bind(featureId)
    .first<PlanRow>();
}

// --- fix attempts (auto-fix loop bookkeeping + iteration cap) ---

// Every attempt counts toward the cap regardless of outcome, so even a
// persistently failing fixer terminates after the cap.
export async function countFixAttempts(repositoryId: number, prNumber: number): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM fix_attempts WHERE repository_id = ?1 AND pr_number = ?2',
  )
    .bind(repositoryId, prNumber)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// Records an attempt only while under the cap and only when no attempt is
// already running for this PR, in a single statement so two concurrent
// consumers (any trigger — a cockpit batch submit, the blocking_review
// webhook) can't both slip past either check and clobber the same sandbox.
// Returns null when blocked. Sweeps zombie rows first: a consumer killed at
// the platform's wall clock never finishes its row, so old 'running' rows
// are closed as failed rather than lying on the dashboard (and blocking new
// attempts) forever.
export async function tryRecordFixAttempt(
  repositoryId: number,
  prNumber: number,
  trigger: string,
  cap: number,
  // When set, only attempts with this trigger count against the cap — so a
  // PR that burned its fix attempts on review-driven fixes can still get
  // conflict resolutions (and vice versa). The running-attempt guard stays
  // global regardless: never two sandbox runs on one PR.
  capTrigger?: string,
): Promise<number | null> {
  await env.DB.prepare(
    `UPDATE fix_attempts SET status = 'failed', error = 'stale: consumer killed before completion'
		 WHERE repository_id = ?1 AND pr_number = ?2 AND status = 'running'
		 AND created_at < datetime('now', '${STALL_CUTOFF_MODIFIER}')`,
  )
    .bind(repositoryId, prNumber)
    .run();
  const row = await env.DB.prepare(
    `INSERT INTO fix_attempts (repository_id, pr_number, "trigger")
		 SELECT ?1, ?2, ?3
		 WHERE (SELECT COUNT(*) FROM fix_attempts
		        WHERE repository_id = ?1 AND pr_number = ?2
		          AND (?5 IS NULL OR "trigger" = ?5)) < ?4
		   AND NOT EXISTS (
		     SELECT 1 FROM fix_attempts
		     WHERE repository_id = ?1 AND pr_number = ?2 AND status = 'running'
		   )
		 RETURNING id`,
  )
    .bind(repositoryId, prNumber, trigger, cap, capTrigger ?? null)
    .first<{ id: number }>();
  return row?.id ?? null;
}

// Open factory PRs on repos that opted into auto conflict resolution — the
// scheduled sweep's work list (see merge-conflicts.ts).
export async function listOpenFactoryPrConflictCandidates(): Promise<
  { repo: RepositoryRow; prNumber: number }[]
> {
  const res = await env.DB.prepare(
    `SELECT r.*, f.pr_number AS factory_pr_number
		 FROM features f
		 JOIN repositories r ON r.id = f.repository_id
		 WHERE f.pr_number IS NOT NULL AND f.status = 'pr_opened'
		   AND r.enabled = 1 AND r.auto_resolve_conflicts = 1
		   AND r.provider = 'github'`,
  ).all<RepositoryRow & { factory_pr_number: number }>();
  return res.results.map(({ factory_pr_number, ...repo }) => ({
    repo,
    prNumber: factory_pr_number,
  }));
}

// --- agent run logs (full session transcripts; content in R2, pointer here) ---

export type AgentRunKind =
  | 'plan_analyze'
  | 'plan_refine'
  | 'generate'
  | 'verify'
  | 'fix'
  | 'automation'
  | 'resolve_conflict';

export interface AgentRunRow {
  id: number;
  kind: AgentRunKind;
  success: number;
  created_at: string;
}

export async function recordAgentRun(
  kind: AgentRunKind,
  logKey: string,
  success: boolean,
  owner: { planId?: number; featureId?: number; fixAttemptId?: number; automationRunId?: number },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO agent_runs (kind, plan_id, feature_id, fix_attempt_id, automation_run_id, log_key, success)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  )
    .bind(
      kind,
      owner.planId ?? null,
      owner.featureId ?? null,
      owner.fixAttemptId ?? null,
      owner.automationRunId ?? null,
      logKey,
      success ? 1 : 0,
    )
    .run();
}

export async function listAgentRunsForPlan(planId: number): Promise<AgentRunRow[]> {
  const res = await env.DB.prepare(
    'SELECT id, kind, success, created_at FROM agent_runs WHERE plan_id = ?1 ORDER BY id',
  )
    .bind(planId)
    .all<AgentRunRow>();
  return res.results;
}

// Direct feature_id rows (generate/verify) plus fix runs resolved through
// fix_attempts' (repository_id, pr_number) → the same feature, the same join
// getFeatureByRepoPr performs — fix_attempts has no feature_id column.
export async function listAgentRunsForFeature(featureId: number): Promise<AgentRunRow[]> {
  const res = await env.DB.prepare(
    `SELECT ar.id, ar.kind, ar.success, ar.created_at
		 FROM agent_runs ar
		 WHERE ar.feature_id = ?1
		 UNION ALL
		 SELECT ar.id, ar.kind, ar.success, ar.created_at
		 FROM agent_runs ar
		 JOIN fix_attempts fa ON fa.id = ar.fix_attempt_id
		 JOIN features f ON f.repository_id = fa.repository_id AND f.pr_number = fa.pr_number
		 WHERE f.id = ?1
		 ORDER BY id`,
  )
    .bind(featureId)
    .all<AgentRunRow>();
  return res.results;
}

// Resolves an agent run to its owning installation for the log route's
// authorization check — only one of the four LEFT JOIN chains matches,
// since a row's plan_id/feature_id/fix_attempt_id/automation_run_id are
// mutually exclusive.
export async function getAgentRunForAuth(
  id: number,
): Promise<{ logKey: string; installationId: number } | null> {
  return env.DB.prepare(
    `SELECT ar.log_key AS logKey,
		        COALESCE(rp.installation_id, rf.installation_id, rx.installation_id, ra.installation_id) AS installationId
		 FROM agent_runs ar
		 LEFT JOIN plans p ON p.id = ar.plan_id
		 LEFT JOIN repositories rp ON rp.id = p.repository_id
		 LEFT JOIN features f ON f.id = ar.feature_id
		 LEFT JOIN repositories rf ON rf.id = f.repository_id
		 LEFT JOIN fix_attempts fa ON fa.id = ar.fix_attempt_id
		 LEFT JOIN repositories rx ON rx.id = fa.repository_id
		 LEFT JOIN automation_runs aur ON aur.id = ar.automation_run_id
		 LEFT JOIN automations au ON au.id = aur.automation_id
		 LEFT JOIN repositories ra ON ra.id = au.repository_id
		 WHERE ar.id = ?1`,
  )
    .bind(id)
    .first<{ logKey: string; installationId: number }>();
}

// --- features (Phase 2: spec → generated branch + PR) ---

export interface FeatureRow {
  id: number;
  repository_id: number;
  title: string;
  spec: string;
  acceptance: string | null; // JSON array of acceptance criteria strings
  branch: string | null;
  pr_number: number | null;
  change_request_id: number | null; // native CR the feature opened (Artifacts)
  criteria_conflict: number; // 1 = awaiting a human criteria-vs-comment decision
  acceptance_updated_at: string | null; // last human edit of the criteria (conflict guard)
  status: string;
  error: string | null;
  created_at: string;
  run_started_at: string | null; // start of the current generation attempt
  tier: string | null; // trivial | standard; scales the agent budget
  author_login: string | null; // instructing user (plan approver); null = bot
  author_id: number | null;
  coauthor_login: string | null; // plan creator when different from author
  coauthor_id: number | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  model: string | null;
  runner_model: string | null; // requested model for this feature's runs; null = default
}

export async function createFeature(
  repositoryId: number,
  title: string,
  spec: string,
  // JSON array of acceptance criteria strings; the verify step checks these
  // empirically against the generated branch.
  acceptance?: string,
  // Commit attribution (src/domain/attribution.ts): author = the instructing
  // user (plan approver), coauthor = the plan creator when they differ.
  // Null for operator/API intakes — the generator commits as the bot.
  author?: { login: string; id: number },
  coauthor?: { login: string; id: number },
  // trivial | standard — scales the generation agent's budget and prompt.
  tier?: string,
  // The plan this feature was approved from, when any (null for direct
  // /internal/generate intakes).
  planId?: number,
): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO features
     (repository_id, title, spec, acceptance, author_login, author_id, coauthor_login, coauthor_id, tier, plan_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) RETURNING id`,
  )
    .bind(
      repositoryId,
      title,
      spec,
      acceptance ?? null,
      author?.login ?? null,
      author?.id ?? null,
      coauthor?.login ?? null,
      coauthor?.id ?? null,
      tier ?? null,
      planId ?? null,
    )
    .first<{ id: number }>();
  return row!.id;
}

export interface ApprovedFeatureFields {
  repositoryId: number;
  title: string;
  spec: string;
  acceptance: string | null;
  authorLogin: string | null;
  authorId: number | null;
  coauthorLogin: string | null;
  coauthorId: number | null;
  tier: string | null;
}

// Claims a ready plan and creates its per-repository features in one D1
// transaction. The unique (plan_id, repository_id) index is the final guard:
// repeated requests and concurrent isolates can never duplicate paid work.
export async function approvePlanFeatures(
  planId: number,
  features: ApprovedFeatureFields[],
): Promise<number[] | null> {
  if (features.length === 0) return null;
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE plans SET status = 'approving'
		 WHERE id = ?1 AND status = 'plan_ready' AND plan IS NOT NULL
		 RETURNING id`,
    ).bind(planId),
    ...features.map((feature) =>
      // runner_model snapshots from the plan so every downstream run
      // (generation, repair, fix) reads the feature row alone.
      env.DB.prepare(
        `INSERT INTO features
		   (repository_id, title, spec, acceptance, author_login, author_id,
		    coauthor_login, coauthor_id, tier, plan_id, runner_model)
		 SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, p.runner_model
		 FROM plans p
		 JOIN plan_repositories pr ON pr.plan_id = p.id AND pr.repository_id = ?1
		 WHERE p.id = ?10 AND p.status = 'approving'
		 ON CONFLICT(plan_id, repository_id) DO NOTHING
		 RETURNING id`,
      ).bind(
        feature.repositoryId,
        feature.title,
        feature.spec,
        feature.acceptance,
        feature.authorLogin,
        feature.authorId,
        feature.coauthorLogin,
        feature.coauthorId,
        feature.tier,
        planId,
      ),
    ),
    env.DB.prepare(
      `UPDATE plans
		 SET status = 'approved',
		     feature_id = (
		       SELECT id FROM features
		       WHERE plan_id = ?1 AND repository_id = plans.repository_id
		       LIMIT 1
		     )
		 WHERE id = ?1 AND status = 'approving'`,
    ).bind(planId),
  ]);
  const claimed = results[0].results.length;
  if (!claimed) return null;
  const rows = await env.DB.prepare(
    `SELECT f.id FROM features f
		 JOIN plan_repositories pr
		   ON pr.plan_id = f.plan_id AND pr.repository_id = f.repository_id
		 WHERE f.plan_id = ?1
		 ORDER BY pr.position`,
  )
    .bind(planId)
    .all<{ id: number }>();
  return rows.results.map((row) => row.id);
}

export async function getFeature(id: number): Promise<FeatureRow | null> {
  return env.DB.prepare('SELECT * FROM features WHERE id = ?1').bind(id).first<FeatureRow>();
}

// Generation runs as a durable Workflow whose steps heartbeat run_started_at,
// so a stranded 'generating' row should be near-impossible — this lazy sweep
// (called from the factory read paths) is the last-resort backstop for an
// engine-level failure. The threshold must exceed the longest heartbeat gap
// (the 25-minute agent step) plus retry delays. Legacy rows without
// run_started_at fall back to created_at.
const GENERATION_STRAND_MINUTES = 45;

export async function failStrandedGeneration(): Promise<number> {
  const res = await env.DB.prepare(
    `UPDATE features SET status = 'failed',
		   error = 'generation run was killed before finishing (platform wall clock or runtime interruption) — retry'
		 WHERE status = 'generating'
		   AND COALESCE(run_started_at, created_at) < datetime('now', '-${GENERATION_STRAND_MINUTES} minutes')`,
  ).run();
  return res.meta.changes ?? 0;
}

export async function updateFeature(
  id: number,
  fields: {
    status?: string;
    branch?: string;
    prNumber?: number;
    error?: string;
    // 'now' stamps the start of a generation attempt (strand detection).
    runStartedAt?: 'now';
    // The generation agent's usage — one CLI run per attempt, so this
    // overwrites rather than accumulates (COALESCE keeps a status-only update
    // from zeroing out a previously recorded cost).
    usage?: CliUsage;
    // Native change request the feature opened (Artifacts repos).
    changeRequestId?: number;
  },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE features SET
		 status = COALESCE(?2, status),
		 branch = COALESCE(?3, branch),
		 pr_number = COALESCE(?4, pr_number),
		 error = COALESCE(?5, error),
		 run_started_at = CASE WHEN ?6 THEN datetime('now') ELSE run_started_at END,
		 input_tokens = COALESCE(?7, input_tokens),
		 output_tokens = COALESCE(?8, output_tokens),
		 cache_read_tokens = COALESCE(?9, cache_read_tokens),
		 cache_write_tokens = COALESCE(?10, cache_write_tokens),
		 cost_usd = COALESCE(?11, cost_usd),
		 model = COALESCE(?12, model),
		 change_request_id = COALESCE(?13, change_request_id)
		 WHERE id = ?1`,
  )
    .bind(
      id,
      fields.status ?? null,
      fields.branch ?? null,
      fields.prNumber ?? null,
      fields.error ?? null,
      fields.runStartedAt === 'now' ? 1 : 0,
      fields.usage?.inputTokens ?? null,
      fields.usage?.outputTokens ?? null,
      fields.usage?.cacheReadTokens ?? null,
      fields.usage?.cacheWriteTokens ?? null,
      fields.usage?.costUsd ?? null,
      fields.usage?.model ?? null,
      fields.changeRequestId ?? null,
    )
    .run();
}

export async function setFeatureCriteriaConflict(id: number, conflict: boolean): Promise<void> {
  await env.DB.prepare('UPDATE features SET criteria_conflict = ?2 WHERE id = ?1')
    .bind(id, conflict ? 1 : 0)
    .run();
}

// Rewrites the acceptance criteria wholesale (the criteria-conflict "update"
// resolution — the user edited the contract) and clears the conflict flag.
export async function updateFeatureAcceptance(id: number, criteria: string[]): Promise<void> {
  await env.DB.prepare(
    `UPDATE features SET acceptance = ?2, criteria_conflict = 0,
		   acceptance_updated_at = datetime('now')
		 WHERE id = ?1`,
  )
    .bind(id, JSON.stringify(criteria))
    .run();
}

// The most recent fix that actually pushed — its trigger tells whether the
// current code state embodies a human instruction (cockpit_comment).
export async function latestFixedAttempt(
  repositoryId: number,
  prNumber: number,
): Promise<{ id: number; trigger: string; created_at: string } | null> {
  return env.DB.prepare(
    `SELECT id, trigger, created_at FROM fix_attempts
		 WHERE repository_id = ?1 AND pr_number = ?2 AND status = 'fixed'
		 ORDER BY id DESC LIMIT 1`,
  )
    .bind(repositoryId, prNumber)
    .first<{ id: number; trigger: string; created_at: string }>();
}

// --- plans (Phase 3: requirements → questions → plan → approve → feature) ---

export interface PlanRow {
  id: number;
  repository_id: number;
  title: string;
  requirements: string;
  analysis: string | null;
  questions: string | null; // JSON array of { text, options?, recommended? } objects
  answers: string | null; // JSON array of strings
  plan: string | null;
  acceptance: string | null; // JSON array of strings
  feature_id: number | null;
  status: string;
  error: string | null;
  created_at: string;
  created_by_login: string | null; // signed-in submitter; null = operator/API
  created_by_id: number | null;
  tier: string | null; // trivial | standard; null = pre-tiering (standard)
  archived: number; // started tasks are never deleted, only hidden
  feedback: string | null; // JSON [{snippet, comment}] awaiting a revise run
  attachments: string | null; // JSON [{key, name, content_type}] in R2
  todo_id: number | null; // unique origin todo; prevents concurrent double-start
  runner_model: string | null; // requested model for this task's runs; null = default
}

// repositoryIds[0] becomes plans.repository_id (the "primary" repo — every
// existing single-repo read path keeps working unchanged); the full ordered
// list is snapshotted into plan_repositories for the multi-repo fan-out at
// approval.
export async function createPlan(
  repositoryIds: number[],
  title: string,
  requirements: string,
  // The signed-in user who submitted the requirements; null for operator/API
  // intakes. Carried onto the feature at approval for commit attribution.
  createdBy?: { login: string; id: number },
  // JSON [{key, name, content_type}] of user-uploaded context files.
  attachments?: string,
): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO plans (repository_id, title, requirements, created_by_login, created_by_id, attachments)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING id`,
  )
    .bind(
      repositoryIds[0],
      title,
      requirements,
      createdBy?.login ?? null,
      createdBy?.id ?? null,
      attachments ?? null,
    )
    .first<{ id: number }>();
  const planId = row!.id;
  await env.DB.batch(
    repositoryIds.map((repoId, i) =>
      env.DB.prepare(
        'INSERT INTO plan_repositories (plan_id, repository_id, position) VALUES (?1, ?2, ?3)',
      ).bind(planId, repoId, i),
    ),
  );
  return planId;
}

export interface CreatePlanForTodoResult {
  planId: number;
  created: boolean;
}

// Idempotent todo start. The first caller inserts the plan; concurrent or
// repeated callers recover the existing plan through plans.todo_id. Repo links
// and the legacy todos.plan_id pointer are then repaired idempotently, so a
// retry also completes a partially interrupted start.
export async function createPlanForTodo(
  todoId: number,
  repositoryIds: number[],
  title: string,
  requirements: string,
  createdBy?: { login: string; id: number },
  attachments?: string,
  // Model for this task's sandboxed runs; null = the default.
  runnerModel?: string,
): Promise<CreatePlanForTodoResult | null> {
  if (repositoryIds.length === 0) return null;
  const inserted = await env.DB.prepare(
    `INSERT INTO plans
		 (repository_id, title, requirements, created_by_login, created_by_id, attachments, todo_id, runner_model)
		 SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
		 FROM todos WHERE id = ?7 AND plan_id IS NULL
		 ON CONFLICT(todo_id) DO NOTHING
		 RETURNING id`,
  )
    .bind(
      repositoryIds[0],
      title,
      requirements,
      createdBy?.login ?? null,
      createdBy?.id ?? null,
      attachments ?? null,
      todoId,
      runnerModel ?? null,
    )
    .first<{ id: number }>();
  const existing = inserted
    ? null
    : await env.DB.prepare('SELECT id FROM plans WHERE todo_id = ?1')
        .bind(todoId)
        .first<{ id: number }>();
  const planId = inserted?.id ?? existing?.id;
  if (!planId) return null;

  await env.DB.batch([
    ...repositoryIds.map((repoId, position) =>
      env.DB.prepare(
        `INSERT INTO plan_repositories (plan_id, repository_id, position)
		   VALUES (?1, ?2, ?3)
		   ON CONFLICT(plan_id, repository_id) DO NOTHING`,
      ).bind(planId, repoId, position),
    ),
    env.DB.prepare(
      `UPDATE todos SET plan_id = ?2
		 WHERE id = ?1 AND (plan_id IS NULL OR plan_id = ?2)`,
    ).bind(todoId, planId),
  ]);
  return { planId, created: inserted !== null };
}

// Change the task's model after start. Propagates to its already-created
// features (they snapshot the plan value at approval) so retries and fix
// runs pick it up; runs already in flight keep the model they launched with.
export async function setTaskRunnerModel(planId: number, model: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('UPDATE plans SET runner_model = ?2 WHERE id = ?1').bind(planId, model),
    env.DB.prepare('UPDATE features SET runner_model = ?2 WHERE plan_id = ?1').bind(planId, model),
  ]);
}

export async function getPlan(id: number): Promise<PlanRow | null> {
  return env.DB.prepare('SELECT * FROM plans WHERE id = ?1').bind(id).first<PlanRow>();
}

export interface PlanWithRepo extends PlanRow {
  owner: string;
  name: string;
  installation_id: number;
  pr_number: number | null; // from the linked feature, if generation started
  feature_status: string | null; // the linked feature's lifecycle status
  feature_error: string | null; // its failure detail, when generation failed
  verification_status: string | null; // latest verification for the feature
  verification_results: string | null; // its per-criterion results JSON
  verification_demo: string | null; // its demo JSON {"video": r2Key}
}

// Plans across the given installations, newest first, with repo + generated-PR
// context for the dashboard.
export async function listPlansForInstallations(
  installationIds: number[],
  limit = 50,
): Promise<PlanWithRepo[]> {
  if (installationIds.length === 0) return [];
  const placeholders = placeholderList(installationIds.length, 2);
  const res = await env.DB.prepare(
    `SELECT p.*, r.owner, r.name, r.installation_id, f.pr_number AS pr_number,
		        f.status AS feature_status, f.error AS feature_error,
		        v.status AS verification_status, v.results AS verification_results,
		        v.demo AS verification_demo
		 FROM plans p
		 JOIN repositories r ON r.id = p.repository_id
		 LEFT JOIN features f ON f.id = p.feature_id
		 LEFT JOIN verifications v ON v.id =
		   (SELECT MAX(id) FROM verifications WHERE feature_id = p.feature_id)
		 WHERE r.installation_id IN (${placeholders})
		 ORDER BY p.id DESC
		 LIMIT ?1`,
  )
    .bind(limit, ...installationIds)
    .all<PlanWithRepo>();
  return res.results;
}

// One plan with the same repo/feature/verification context as the list query
// (the board's task-detail view).
export async function getPlanWithRepoById(id: number): Promise<PlanWithRepo | null> {
  return env.DB.prepare(
    `SELECT p.*, r.owner, r.name, r.installation_id, f.pr_number AS pr_number,
		        f.status AS feature_status, f.error AS feature_error,
		        v.status AS verification_status, v.results AS verification_results,
		        v.demo AS verification_demo
		 FROM plans p
		 JOIN repositories r ON r.id = p.repository_id
		 LEFT JOIN features f ON f.id = p.feature_id
		 LEFT JOIN verifications v ON v.id =
		   (SELECT MAX(id) FROM verifications WHERE feature_id = p.feature_id)
		 WHERE p.id = ?1`,
  )
    .bind(id)
    .first<PlanWithRepo>();
}

export async function updatePlan(
  id: number,
  fields: {
    status?: string;
    analysis?: string;
    questions?: string;
    answers?: string;
    plan?: string;
    acceptance?: string;
    featureId?: number;
    error?: string;
    tier?: string;
    feedback?: string;
  },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE plans SET
		 status = COALESCE(?2, status),
		 analysis = COALESCE(?3, analysis),
		 questions = COALESCE(?4, questions),
		 answers = COALESCE(?5, answers),
		 plan = COALESCE(?6, plan),
		 acceptance = COALESCE(?7, acceptance),
		 feature_id = COALESCE(?8, feature_id),
		 error = COALESCE(?9, error),
		 tier = COALESCE(?10, tier),
		 feedback = COALESCE(?11, feedback)
		 WHERE id = ?1`,
  )
    .bind(
      id,
      fields.status ?? null,
      fields.analysis ?? null,
      fields.questions ?? null,
      fields.answers ?? null,
      fields.plan ?? null,
      fields.acceptance ?? null,
      fields.featureId ?? null,
      fields.error ?? null,
      fields.tier ?? null,
      fields.feedback ?? null,
    )
    .run();
}

// --- push subscriptions (Web Push, src/services/push-notifications.ts) ---

export interface PushSubscriptionRow {
  id: number;
  user_github_id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at: string;
}

// A device re-subscribing (possibly under a different signed-in user, e.g. a
// shared machine) must repoint the row rather than fail — endpoint is the
// natural key, not (user, endpoint).
export async function upsertPushSubscription(
  userGithubId: number,
  sub: { endpoint: string; p256dh: string; auth: string },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO push_subscriptions (user_github_id, endpoint, p256dh, auth)
		 VALUES (?1, ?2, ?3, ?4)
		 ON CONFLICT(endpoint) DO UPDATE SET
		   user_github_id = excluded.user_github_id,
		   p256dh = excluded.p256dh,
		   auth = excluded.auth`,
  )
    .bind(userGithubId, sub.endpoint, sub.p256dh, sub.auth)
    .run();
}

// Scoped to the calling user so one user can't delete another's subscription
// by guessing an endpoint.
export async function deletePushSubscriptionByEndpoint(
  userGithubId: number,
  endpoint: string,
): Promise<void> {
  await env.DB.prepare('DELETE FROM push_subscriptions WHERE user_github_id = ?1 AND endpoint = ?2')
    .bind(userGithubId, endpoint)
    .run();
}

export async function listPushSubscriptionsForUser(
  userGithubId: number,
): Promise<PushSubscriptionRow[]> {
  const res = await env.DB.prepare('SELECT * FROM push_subscriptions WHERE user_github_id = ?1')
    .bind(userGithubId)
    .all<PushSubscriptionRow>();
  return res.results;
}

// Used by the send path to prune expired endpoints (410/404 responses).
export async function deletePushSubscriptionById(id: number): Promise<void> {
  await env.DB.prepare('DELETE FROM push_subscriptions WHERE id = ?1').bind(id).run();
}

export async function finishFixAttempt(
  id: number,
  status: string,
  commitSha?: string,
  error?: string,
  usage?: CliUsage,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE fix_attempts SET
		 status = ?2, commit_sha = ?3, error = ?4,
		 input_tokens = ?5, output_tokens = ?6, cache_read_tokens = ?7, cache_write_tokens = ?8,
		 cost_usd = ?9, model = ?10
		 WHERE id = ?1`,
  )
    .bind(
      id,
      status,
      commitSha ?? null,
      error ?? null,
      usage?.inputTokens ?? 0,
      usage?.outputTokens ?? 0,
      usage?.cacheReadTokens ?? 0,
      usage?.cacheWriteTokens ?? 0,
      usage?.costUsd ?? 0,
      usage?.model ?? null,
    )
    .run();
}

// Claims the (agent, repo, PR) instance for a new dispatch. agent_instance_id
// is deterministic per (agent, repo, PR) and intentionally reused across
// re-reviews (see dispatchReviewAgent), so two concurrent/redelivered
// dispatches for the same instance must never both insert a 'running' row —
// every completion/usage write resolves "the row to update" by instance id +
// status='running', so a duplicate row causes writes to land on the wrong
// dispatch. Mirrors tryRecordFixAttempt / tryRecordAutomationRun: sweep stale
// rows, then insert atomically guarded by NOT EXISTS. Returns null when
// another dispatch for this exact instance is already in flight. The sweep
// threshold is STALL_CUTOFF_MODIFIER (shared/time.ts), the same cutoff that
// drives the 'stalled' UI label.
export async function tryRecordReview(
  repositoryId: number,
  installationId: number,
  prNumber: number,
  trigger: string,
  agentSlug: string,
  agentInstanceId: string,
  riskTier: string | null = null,
): Promise<number | null> {
  await env.DB.prepare(
    `UPDATE reviews SET status = 'failed', completed_at = datetime('now')
		 WHERE agent_instance_id = ?1 AND status = 'running'
		 AND created_at < datetime('now', '${STALL_CUTOFF_MODIFIER}')`,
  )
    .bind(agentInstanceId)
    .run();
  const row = await env.DB.prepare(
    `INSERT INTO reviews (repository_id, installation_id, pr_number, trigger_event, status, agent_slug, agent_instance_id, risk_tier)
		 SELECT ?1, ?2, ?3, ?4, 'running', ?5, ?6, ?7
		 WHERE NOT EXISTS (
		   SELECT 1 FROM reviews WHERE agent_instance_id = ?6 AND status = 'running'
		 )
		 RETURNING id`,
  )
    .bind(repositoryId, installationId, prNumber, trigger, agentSlug, agentInstanceId, riskTier)
    .first<{ id: number }>();
  return row?.id ?? null;
}

// Called by the post_review tool once the agent has published to GitHub.
// Keyed by the exact agent instance so concurrent agents reviewing the same
// PR can never complete each other's rows.
export async function completeReview(
  agentInstanceId: string,
  reviewUrl: string | null,
  findingsCount: number | null = null,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE reviews
		 SET status = 'completed', completed_at = datetime('now'), review_url = ?2, findings_count = ?3
		 WHERE id = (
			SELECT id FROM reviews
			WHERE agent_instance_id = ?1 AND status = 'running'
			ORDER BY id DESC LIMIT 1
		 )`,
  )
    .bind(agentInstanceId, reviewUrl, findingsCount)
    .run();
}

// Accumulates one model turn's usage onto the latest review row for an agent
// instance. Fired from the observe() metering subscriber.
export async function addReviewUsage(
  agentInstanceId: string,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
    model: string;
  },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE reviews SET
			input_tokens = input_tokens + ?2,
			output_tokens = output_tokens + ?3,
			cache_read_tokens = cache_read_tokens + ?4,
			cache_write_tokens = cache_write_tokens + ?5,
			cost_usd = cost_usd + ?6,
			model = ?7
		 WHERE id = (
			SELECT id FROM reviews WHERE agent_instance_id = ?1
			ORDER BY id DESC LIMIT 1
		 )`,
  )
    .bind(
      agentInstanceId,
      usage.inputTokens,
      usage.outputTokens,
      usage.cacheReadTokens,
      usage.cacheWriteTokens,
      usage.costUsd,
      usage.model,
    )
    .run();
}
