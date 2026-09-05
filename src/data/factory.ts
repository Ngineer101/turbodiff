import { sql } from 'drizzle-orm';
import type { CriterionResult } from '../domain/verification.ts';
import type { ApiPlanQuestion } from '../shared/api-types.ts';
import { STALL_AFTER_MINUTES, VERIFY_STALL_AFTER_MINUTES } from '../shared/time.ts';
import type { CliUsage } from '../shared/usage.ts';
import { execute, queryOne, queryRows, withTransaction } from './database.ts';
import type { RepositoryRow } from './repositories.ts';
import { bigintArray, minutesAgo } from './sql.ts';

// --- verifications (Phase 4: empirical acceptance-criteria checks) ---

export interface VerificationRow {
  id: number;
  feature_id: number;
  status: string;
  results: CriterionResult[] | null;
  summary: string | null;
  demo: { video?: string; caption?: string } | null;
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
  const row = await queryOne<{ id: number }>(sql`
    INSERT INTO app.cockpit_comments (feature_id, path, line, side, body, author, author_id)
    VALUES (${featureId}, ${path}, ${line}, ${side}, ${body}, ${author}, ${authorId ?? null})
    RETURNING id
  `);
  return row!.id;
}

// Atomically claims every open comment on a feature into one batch, so two
// concurrent Submit clicks can't both grab the same comment into two
// separate fix runs.
export async function dispatchOpenCockpitComments(featureId: number): Promise<CockpitCommentRow[]> {
  return queryRows<CockpitCommentRow>(sql`
    UPDATE app.cockpit_comments SET status = 'dispatched'
    WHERE feature_id = ${featureId} AND status = 'open'
    RETURNING *
  `);
}

export async function linkCommentsToFixAttempt(
  commentIds: number[],
  attemptId: number,
): Promise<void> {
  if (commentIds.length === 0) return;
  await execute(sql`
    UPDATE app.cockpit_comments SET fix_attempt_id = ${attemptId}
    WHERE id = ANY(${bigintArray(commentIds)})
  `);
}

export async function hasRunningFixAttempt(
  repositoryId: number,
  prNumber: number,
): Promise<boolean> {
  const row = await queryOne<{ id: number }>(sql`
    SELECT id FROM app.fix_attempts
    WHERE repository_id = ${repositoryId} AND pr_number = ${prNumber}
      AND status = 'running' LIMIT 1
  `);
  return row !== null;
}

export async function listCockpitComments(featureId: number): Promise<CockpitCommentRow[]> {
  return queryRows<CockpitCommentRow>(sql`
    SELECT c.*, fa.status AS fix_status, fa.commit_sha AS fix_commit_sha,
      fa.error AS fix_error
    FROM app.cockpit_comments c
    LEFT JOIN app.fix_attempts fa ON fa.id = c.fix_attempt_id
    WHERE c.feature_id = ${featureId} ORDER BY c.id
  `);
}

// --- multi-repo task/plan repo lists ---

// Replaces a todo's repo list wholesale (delete-then-insert), so repeated
// calls with a different array simply replace the prior selection.
export async function setTodoRepositories(todoId: number, repositoryIds: number[]): Promise<void> {
  await withTransaction(async (transaction) => {
    await transaction.execute(sql`
        DELETE FROM app.todo_repositories WHERE todo_id = ${todoId}
      `);
    for (const [position, repositoryId] of repositoryIds.entries()) {
      await transaction.execute(sql`
          INSERT INTO app.todo_repositories (todo_id, repository_id, position)
          VALUES (${todoId}, ${repositoryId}, ${position})
        `);
    }
  });
}

export async function listReposForTodo(todoId: number): Promise<RepositoryRow[]> {
  return queryRows<RepositoryRow>(sql`
    SELECT r.* FROM app.todo_repositories tr
    JOIN app.repositories r ON r.id = tr.repository_id
    WHERE tr.todo_id = ${todoId}
    ORDER BY tr.position
  `);
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
  return queryRows<TodoRepoRow>(sql`
    SELECT tr.todo_id, tr.repository_id, r.owner, r.name
    FROM app.todo_repositories tr
    JOIN app.repositories r ON r.id = tr.repository_id
    WHERE tr.todo_id = ANY(${bigintArray(todoIds)})
    ORDER BY tr.todo_id, tr.position
  `);
}

// Board rollup form: installation-scoped so it can run in parallel with the
// todo list instead of waiting for its ids and starting a second PostgreSQL phase.
export async function boardTodoRepositories(installationIds: number[]): Promise<TodoRepoRow[]> {
  if (installationIds.length === 0) return [];
  return queryRows<TodoRepoRow>(sql`
    SELECT tr.todo_id, tr.repository_id, r.owner, r.name
    FROM app.todo_repositories tr
    JOIN app.todos t ON t.id = tr.todo_id
    JOIN app.repositories r ON r.id = tr.repository_id
    WHERE t.installation_id = ANY(${bigintArray(installationIds)}) AND t.plan_id IS NULL
    ORDER BY tr.todo_id, tr.position
  `);
}

export async function listReposForPlan(planId: number): Promise<RepositoryRow[]> {
  return queryRows<RepositoryRow>(sql`
    SELECT r.* FROM app.plan_repositories pr
    JOIN app.repositories r ON r.id = pr.repository_id
    WHERE pr.plan_id = ${planId}
    ORDER BY pr.position
  `);
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
  verification_created_at: string | null;
  verification_results: CriterionResult[] | null;
}

// One row per repo attached to each of the given plans — the board/task
// routes' per-repo status array. Independent of listPlansForInstallations /
// getPlanWithRepoById, which stay keyed to the primary repo only.
export async function getTaskRepoStatuses(planIds: number[]): Promise<TaskRepoStatusRow[]> {
  if (planIds.length === 0) return [];
  return queryRows<TaskRepoStatusRow>(sql`
    SELECT pr.plan_id, pr.repository_id, r.owner, r.name, r.provider,
      f.id AS feature_id, f.status AS feature_status, f.error AS feature_error,
      f.pr_number, v.status AS verification_status, v.results AS verification_results,
      v.created_at AS verification_created_at
    FROM app.plan_repositories pr
    JOIN app.repositories r ON r.id = pr.repository_id
    LEFT JOIN app.features f
      ON f.plan_id = pr.plan_id AND f.repository_id = pr.repository_id
    LEFT JOIN app.verifications v ON v.id = (
      SELECT MAX(id) FROM app.verifications WHERE feature_id = f.id
    )
    WHERE pr.plan_id = ANY(${bigintArray(planIds)})
    ORDER BY pr.plan_id, pr.position
  `);
}

// Board rollup form: installation-scoped so statuses load alongside plans in
// the first PostgreSQL wave. The id-scoped variant remains for the task detail route.
export async function boardTaskRepoStatuses(
  installationIds: number[],
): Promise<TaskRepoStatusRow[]> {
  if (installationIds.length === 0) return [];
  return queryRows<TaskRepoStatusRow>(sql`
    SELECT pr.plan_id, pr.repository_id, r.owner, r.name, r.provider,
      f.id AS feature_id, f.status AS feature_status, f.error AS feature_error,
      f.pr_number, v.status AS verification_status, v.results AS verification_results,
      v.created_at AS verification_created_at
    FROM app.plan_repositories pr
    JOIN app.plans p ON p.id = pr.plan_id
    JOIN app.repositories r ON r.id = pr.repository_id
    LEFT JOIN app.features f
      ON f.plan_id = pr.plan_id AND f.repository_id = pr.repository_id
    LEFT JOIN app.verifications v ON v.id = (
      SELECT MAX(id) FROM app.verifications WHERE feature_id = f.id
    )
    WHERE r.installation_id = ANY(${bigintArray(installationIds)}) AND NOT p.archived
    ORDER BY pr.plan_id, pr.position
  `);
}

// The feature a factory PR belongs to (null for human-authored PRs).
export async function getFeatureByRepoPr(
  repositoryId: number,
  prNumber: number,
): Promise<FeatureRow | null> {
  return queryOne<FeatureRow>(sql`
    SELECT * FROM app.features
    WHERE repository_id = ${repositoryId} AND pr_number = ${prNumber}
    ORDER BY id DESC LIMIT 1
  `);
}

export async function latestVerificationForFeature(
  featureId: number,
): Promise<VerificationRow | null> {
  return queryOne<VerificationRow>(sql`
    SELECT * FROM app.verifications WHERE feature_id = ${featureId}
    ORDER BY id DESC LIMIT 1
  `);
}

// Verification runs killed mid-flight (isolate death) never reach their
// error handler, stranding rows in 'running' and the UI in an endless poll.
// Lazy sweep from the read paths, like failStrandedGeneration.
export async function failStrandedVerifications(): Promise<number> {
  return execute(sql`
    UPDATE app.verifications SET status = 'error',
      error = 'verification run was killed before finishing — re-run it from the PR or wait for the next push'
    WHERE status = 'running'
      AND created_at < ${minutesAgo(VERIFY_STALL_AFTER_MINUTES)}
  `);
}

export async function createVerification(featureId: number): Promise<number> {
  return withTransaction(async (transaction) => {
    // The partial unique index is the final concurrency guard. Close a run
    // that outlived the same threshold used by startVerification before the
    // replacement INSERT, so a cron tick is not required to release it.
    await transaction.execute(sql`
      UPDATE app.verifications SET status = 'error',
        error = 'verification run was killed before finishing — replaced by a new run'
      WHERE feature_id = ${featureId} AND status = 'running'
        AND created_at < ${minutesAgo(VERIFY_STALL_AFTER_MINUTES)}
    `);
    const result = await transaction.execute<{ id: number }>(sql`
      INSERT INTO app.verifications (feature_id) VALUES (${featureId}) RETURNING id
    `);
    return result.rows[0]!.id;
  });
}

export async function finishVerification(
  id: number,
  status: string,
  fields: {
    results?: CriterionResult[];
    summary?: string;
    error?: string;
    demo?: { video?: string; caption?: string };
    usage?: CliUsage;
  } = {},
): Promise<void> {
  await execute(sql`
    UPDATE app.verifications SET
      status = ${status},
      results = ${fields.results ? JSON.stringify(fields.results) : null}::jsonb,
      summary = ${fields.summary ?? null}, error = ${fields.error ?? null},
      demo = ${fields.demo ? JSON.stringify(fields.demo) : null}::jsonb,
      input_tokens = ${fields.usage?.inputTokens ?? 0},
      output_tokens = ${fields.usage?.outputTokens ?? 0},
      cache_read_tokens = ${fields.usage?.cacheReadTokens ?? 0},
      cache_write_tokens = ${fields.usage?.cacheWriteTokens ?? 0},
      cost_usd = ${fields.usage?.costUsd ?? 0}, model = ${fields.usage?.model ?? null}
    WHERE id = ${id}
  `);
}

// The plan a factory feature came from (null for direct /internal/generate).
// Every plan-originated feature sets features.plan_id at creation, so this
// resolves correctly for every repo's feature in a multi-repo task — not
// just the primary repo's via the legacy plans.feature_id pointer.
export async function getPlanByFeatureId(featureId: number): Promise<PlanRow | null> {
  return queryOne<PlanRow>(sql`
    SELECT p.* FROM app.plans p JOIN app.features f ON f.plan_id = p.id
    WHERE f.id = ${featureId}
  `);
}

// --- fix attempts (auto-fix loop bookkeeping + iteration cap) ---

// Every attempt counts toward the cap regardless of outcome, so even a
// persistently failing fixer terminates after the cap.
export async function countFixAttempts(repositoryId: number, prNumber: number): Promise<number> {
  const row = await queryOne<{ n: number }>(sql`
    SELECT COUNT(*) AS n FROM app.fix_attempts
    WHERE repository_id = ${repositoryId} AND pr_number = ${prNumber}
  `);
  return row?.n ?? 0;
}

// Records an attempt only while under the cap and only when no attempt is
// already running for this PR. The partial unique index is the concurrency
// guard, so two consumers can't both claim the same sandbox.
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
  // conflict resolutions (and vice versa). When null, every attempt counts
  // EXCEPT 'chat' turns: those are human-supervised, so they never consume
  // the automated-fix cap. The running-attempt guard stays global
  // regardless: never two sandbox runs on one PR — chat turns both honor
  // and hold that lock like any other attempt.
  capTrigger?: string,
  stageRunId: number | null = null,
): Promise<number | null> {
  return withTransaction(async (transaction) => {
    await transaction.execute(sql`
        UPDATE app.fix_attempts
        SET status = 'failed', error = 'stale: consumer killed before completion'
        WHERE repository_id = ${repositoryId} AND pr_number = ${prNumber}
          AND status = 'running'
          AND created_at < ${minutesAgo(STALL_AFTER_MINUTES)}
      `);
    const result = await transaction.execute<{ id: number }>(sql`
        INSERT INTO app.fix_attempts (repository_id, pr_number, "trigger", stage_run_id)
        SELECT ${repositoryId}, ${prNumber}, ${trigger}, ${stageRunId}
        WHERE (
          SELECT COUNT(*) FROM app.fix_attempts
          WHERE repository_id = ${repositoryId} AND pr_number = ${prNumber}
            AND ((${capTrigger ?? null}::text IS NOT NULL AND "trigger" = ${capTrigger ?? null})
              OR (${capTrigger ?? null}::text IS NULL AND "trigger" <> 'chat'))
        ) < ${cap}
        ON CONFLICT DO NOTHING
        RETURNING id
      `);
    return result.rows[0]?.id ?? null;
  });
}

// Open factory PRs on repos that opted into auto conflict resolution — the
// scheduled sweep's work list (see merge-conflicts.ts).
export async function listOpenFactoryPrConflictCandidates(): Promise<
  { repo: RepositoryRow; prNumber: number }[]
> {
  const rows = await queryRows<RepositoryRow & { factory_pr_number: number }>(sql`
    SELECT r.*, f.pr_number AS factory_pr_number
    FROM app.features f
    JOIN app.repositories r ON r.id = f.repository_id
    WHERE f.pr_number IS NOT NULL AND f.status = 'pr_opened'
      AND r.enabled AND r.auto_resolve_conflicts
      AND r.provider = 'github'
  `);
  return rows.map(({ factory_pr_number, ...repo }) => ({
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
  | 'chat'
  | 'automation'
  | 'resolve_conflict';

export interface AgentRunRow {
  id: number;
  kind: AgentRunKind;
  success: boolean;
  created_at: string;
}

export async function recordAgentRun(
  kind: AgentRunKind,
  logKey: string,
  success: boolean,
  owner: { planId?: number; featureId?: number; fixAttemptId?: number; automationRunId?: number },
): Promise<void> {
  await execute(sql`
    INSERT INTO app.agent_runs
      (kind, plan_id, feature_id, fix_attempt_id, automation_run_id, log_key, success)
    VALUES (
      ${kind}, ${owner.planId ?? null}, ${owner.featureId ?? null},
      ${owner.fixAttemptId ?? null}, ${owner.automationRunId ?? null},
      ${logKey}, ${success}
    )
  `);
}

export async function listAgentRunsForPlan(planId: number): Promise<AgentRunRow[]> {
  return queryRows<AgentRunRow>(sql`
    SELECT id, kind, success, created_at FROM app.agent_runs
    WHERE plan_id = ${planId} ORDER BY id
  `);
}

// Direct feature_id rows (generate/verify) plus fix runs resolved through
// fix_attempts' (repository_id, pr_number) → the same feature, the same join
// getFeatureByRepoPr performs — fix_attempts has no feature_id column.
export async function listAgentRunsForFeature(featureId: number): Promise<AgentRunRow[]> {
  return queryRows<AgentRunRow>(sql`
    SELECT ar.id, ar.kind, ar.success, ar.created_at
    FROM app.agent_runs ar
    WHERE ar.feature_id = ${featureId}
    UNION ALL
    SELECT ar.id, ar.kind, ar.success, ar.created_at
    FROM app.agent_runs ar
    JOIN app.fix_attempts fa ON fa.id = ar.fix_attempt_id
    JOIN app.features f
      ON f.repository_id = fa.repository_id AND f.pr_number = fa.pr_number
    WHERE f.id = ${featureId}
    ORDER BY id
  `);
}

// Resolves an agent run to its owning installation for the log route's
// authorization check — only one of the four LEFT JOIN chains matches,
// since a row's plan_id/feature_id/fix_attempt_id/automation_run_id are
// mutually exclusive.
export async function getAgentRunForAuth(
  id: number,
): Promise<{ logKey: string; installationId: number } | null> {
  return queryOne<{ logKey: string; installationId: number }>(sql`
    SELECT ar.log_key AS "logKey",
      COALESCE(
        rp.installation_id, rf.installation_id, rx.installation_id, ra.installation_id
      ) AS "installationId"
    FROM app.agent_runs ar
    LEFT JOIN app.plans p ON p.id = ar.plan_id
    LEFT JOIN app.repositories rp ON rp.id = p.repository_id
    LEFT JOIN app.features f ON f.id = ar.feature_id
    LEFT JOIN app.repositories rf ON rf.id = f.repository_id
    LEFT JOIN app.fix_attempts fa ON fa.id = ar.fix_attempt_id
    LEFT JOIN app.repositories rx ON rx.id = fa.repository_id
    LEFT JOIN app.automation_runs aur ON aur.id = ar.automation_run_id
    LEFT JOIN app.automations au ON au.id = aur.automation_id
    LEFT JOIN app.repositories ra ON ra.id = au.repository_id
    WHERE ar.id = ${id}
  `);
}

// --- features (Phase 2: spec → generated branch + PR) ---

export interface FeatureRow {
  id: number;
  repository_id: number;
  title: string;
  spec: string;
  acceptance: string[] | null;
  branch: string | null;
  pr_number: number | null;
  change_request_id: number | null; // native CR the feature opened (Artifacts)
  change_id: number | null; // provider-neutral change identity
  criteria_conflict: boolean; // awaiting a human criteria-vs-comment decision
  acceptance_updated_at: string | null; // last human edit of the criteria (conflict guard)
  proposed_acceptance: string[] | null;
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
  chat_session_id: string | null; // resumable Claude CLI session for cockpit chat
}

export async function createFeature(
  repositoryId: number,
  title: string,
  spec: string,
  // Acceptance criteria checked empirically against the generated branch.
  acceptance?: string[],
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
  const row = await queryOne<{ id: number }>(sql`
    INSERT INTO app.features
      (repository_id, title, spec, acceptance, author_login, author_id,
       coauthor_login, coauthor_id, tier, plan_id)
    VALUES (
      ${repositoryId}, ${title}, ${spec},
      ${acceptance ? JSON.stringify(acceptance) : null}::jsonb,
      ${author?.login ?? null}, ${author?.id ?? null}, ${coauthor?.login ?? null},
      ${coauthor?.id ?? null}, ${tier ?? null}, ${planId ?? null}
    )
    RETURNING id
  `);
  return row!.id;
}

export interface ApprovedFeatureFields {
  repositoryId: number;
  title: string;
  spec: string;
  acceptance: string[] | null;
  authorLogin: string | null;
  authorId: number | null;
  coauthorLogin: string | null;
  coauthorId: number | null;
  tier: string | null;
}

// Claims a ready plan and creates its per-repository features in one PostgreSQL
// transaction. The unique (plan_id, repository_id) index is the final guard:
// repeated requests and concurrent isolates can never duplicate paid work.
export async function approvePlanFeatures(
  planId: number,
  features: ApprovedFeatureFields[],
): Promise<number[] | null> {
  if (features.length === 0) return null;
  return withTransaction(async (transaction) => {
    const claimed = await transaction.execute<{ id: number }>(sql`
        UPDATE app.plans SET status = 'approving'
        WHERE id = ${planId} AND status = 'plan_ready' AND plan IS NOT NULL
        RETURNING id
      `);
    if (!claimed.rows[0]) return null;

    // runner_model snapshots from the plan so every downstream run
    // (generation, repair, fix) reads the feature row alone.
    for (const feature of features) {
      await transaction.execute(sql`
          INSERT INTO app.features
            (repository_id, title, spec, acceptance, author_login, author_id,
             coauthor_login, coauthor_id, tier, plan_id, runner_model)
          SELECT ${feature.repositoryId}, ${feature.title}, ${feature.spec},
            ${feature.acceptance ? JSON.stringify(feature.acceptance) : null}::jsonb,
            ${feature.authorLogin}, ${feature.authorId},
            ${feature.coauthorLogin}, ${feature.coauthorId}, ${feature.tier}, ${planId},
            p.runner_model
          FROM app.plans p
          JOIN app.plan_repositories pr
            ON pr.plan_id = p.id AND pr.repository_id = ${feature.repositoryId}
          WHERE p.id = ${planId} AND p.status = 'approving'
          ON CONFLICT(plan_id, repository_id) DO NOTHING
        `);
    }

    await transaction.execute(sql`
        UPDATE app.plans
        SET status = 'approved',
          feature_id = (
            SELECT id FROM app.features
            WHERE plan_id = ${planId} AND repository_id = plans.repository_id
            LIMIT 1
          )
        WHERE id = ${planId} AND status = 'approving'
      `);
    const created = await transaction.execute<{ id: number }>(sql`
        SELECT f.id FROM app.features f
        JOIN app.plan_repositories pr
          ON pr.plan_id = f.plan_id AND pr.repository_id = f.repository_id
        WHERE f.plan_id = ${planId}
        ORDER BY pr.position
      `);
    return created.rows.map((row) => row.id);
  });
}

export async function getFeature(id: number): Promise<FeatureRow | null> {
  return queryOne<FeatureRow>(sql`SELECT * FROM app.features WHERE id = ${id}`);
}

// Generation runs as a durable Workflow whose steps heartbeat run_started_at,
// so a stranded 'generating' row should be near-impossible — this lazy sweep
// (called from the factory read paths) is the last-resort backstop for an
// engine-level failure. The threshold must exceed the longest heartbeat gap
// (the 25-minute agent step) plus retry delays. Legacy rows without
// run_started_at fall back to created_at.
const GENERATION_STRAND_MINUTES = 45;

// This singleton row is updated by transactional triggers. A reader can only
// observe a new version after the write that caused it commits, so immutable
// board snapshots can never be cached under a version for uncommitted data.
export async function factoryVersion(): Promise<number> {
  const row = await queryOne<{ version: number }>(sql`
    SELECT version FROM app.factory_version WHERE id = 1
  `);
  return row?.version ?? 0;
}

export async function failStrandedGeneration(): Promise<number> {
  return execute(sql`
    UPDATE app.features SET status = 'failed',
      error = 'generation run was killed before finishing (platform wall clock or runtime interruption) — retry'
    WHERE status = 'generating'
      AND COALESCE(run_started_at, created_at) < ${minutesAgo(GENERATION_STRAND_MINUTES)}
  `);
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
    changeId?: number;
  },
): Promise<void> {
  await execute(sql`
    UPDATE app.features SET
      status = COALESCE(${fields.status ?? null}::text, status),
      branch = COALESCE(${fields.branch ?? null}::text, branch),
      pr_number = COALESCE(${fields.prNumber ?? null}::integer, pr_number),
      error = COALESCE(${fields.error ?? null}::text, error),
      run_started_at = CASE
        WHEN ${fields.runStartedAt === 'now'} THEN CURRENT_TIMESTAMP ELSE run_started_at
      END,
      input_tokens = COALESCE(${fields.usage?.inputTokens ?? null}::bigint, input_tokens),
      output_tokens = COALESCE(${fields.usage?.outputTokens ?? null}::bigint, output_tokens),
      cache_read_tokens = COALESCE(
        ${fields.usage?.cacheReadTokens ?? null}::bigint, cache_read_tokens
      ),
      cache_write_tokens = COALESCE(
        ${fields.usage?.cacheWriteTokens ?? null}::bigint, cache_write_tokens
      ),
      cost_usd = COALESCE(${fields.usage?.costUsd ?? null}::numeric, cost_usd),
      model = COALESCE(${fields.usage?.model ?? null}::text, model),
      change_request_id = COALESCE(
        ${fields.changeRequestId ?? null}::bigint, change_request_id
      ),
      change_id = COALESCE(
        ${fields.changeId ?? null}::bigint, change_id
      )
    WHERE id = ${id}
  `);
}

export async function setFeatureCriteriaConflict(id: number, conflict: boolean): Promise<void> {
  await execute(sql`
    UPDATE app.features SET criteria_conflict = ${conflict} WHERE id = ${id}
  `);
}

export async function setProposedAcceptance(id: number, criteria: string[] | null): Promise<void> {
  await execute(sql`
    UPDATE app.features
    SET proposed_acceptance = ${criteria ? JSON.stringify(criteria) : null}::jsonb
    WHERE id = ${id}
  `);
}

// Rewrites the acceptance criteria wholesale (the criteria-conflict "update"
// resolution — the user edited the contract) and clears the conflict flag.
export async function updateFeatureAcceptance(id: number, criteria: string[]): Promise<void> {
  await execute(sql`
    UPDATE app.features SET acceptance = ${JSON.stringify(criteria)}::jsonb,
      criteria_conflict = FALSE, acceptance_updated_at = CURRENT_TIMESTAMP,
      proposed_acceptance = NULL
    WHERE id = ${id}
  `);
}

// The most recent fix that actually pushed — its trigger tells whether the
// current code state embodies a human instruction (cockpit_comment).
export async function latestFixedAttempt(
  repositoryId: number,
  prNumber: number,
): Promise<{ id: number; trigger: string; created_at: string } | null> {
  return queryOne<{ id: number; trigger: string; created_at: string }>(sql`
    SELECT id, "trigger", created_at FROM app.fix_attempts
    WHERE repository_id = ${repositoryId} AND pr_number = ${prNumber}
      AND status = 'fixed'
    ORDER BY id DESC LIMIT 1
  `);
}

// --- plans (Phase 3: requirements → questions → plan → approve → feature) ---

export interface PlanRow {
  id: number;
  repository_id: number;
  title: string;
  requirements: string;
  analysis: string | null;
  questions: ApiPlanQuestion[] | null;
  answers: string[] | null;
  plan: string | null;
  summary: string | null; // reader-facing short summary; null = trivial tier or pre-summary plan
  acceptance: string[] | null;
  feature_id: number | null;
  status: string;
  error: string | null;
  created_at: string;
  created_by_login: string | null; // signed-in submitter; null = operator/API
  created_by_id: number | null;
  tier: string | null; // trivial | standard; null = pre-tiering (standard)
  archived: boolean; // started tasks are never deleted, only hidden
  feedback: string | null; // JSON [{snippet, comment}] awaiting a revise run
  attachments: { key: string; name: string; content_type: string }[] | null;
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
  attachments?: { key: string; name: string; content_type: string }[],
): Promise<number> {
  const primaryRepositoryId = repositoryIds[0];
  if (primaryRepositoryId === undefined) throw new Error('a plan requires at least one repository');
  return withTransaction(async (transaction) => {
    const inserted = await transaction.execute<{ id: number }>(sql`
        INSERT INTO app.plans
          (repository_id, title, requirements, created_by_login, created_by_id, attachments)
        VALUES (
          ${primaryRepositoryId}, ${title}, ${requirements}, ${createdBy?.login ?? null},
          ${createdBy?.id ?? null}, ${attachments ? JSON.stringify(attachments) : null}::jsonb
        )
        RETURNING id
      `);
    const planId = inserted.rows[0]!.id;
    for (const [position, repositoryId] of repositoryIds.entries()) {
      await transaction.execute(sql`
          INSERT INTO app.plan_repositories (plan_id, repository_id, position)
          VALUES (${planId}, ${repositoryId}, ${position})
        `);
    }
    return planId;
  });
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
  attachments?: { key: string; name: string; content_type: string }[],
  // Model for this task's sandboxed runs; null = the default.
  runnerModel?: string,
): Promise<CreatePlanForTodoResult | null> {
  if (repositoryIds.length === 0) return null;
  const primaryRepositoryId = repositoryIds[0]!;
  return withTransaction(async (transaction) => {
    const inserted = await transaction.execute<{ id: number }>(sql`
        INSERT INTO app.plans
          (repository_id, title, requirements, created_by_login, created_by_id,
           attachments, todo_id, runner_model)
        SELECT ${primaryRepositoryId}, ${title}, ${requirements},
          ${createdBy?.login ?? null}, ${createdBy?.id ?? null},
          ${attachments ? JSON.stringify(attachments) : null}::jsonb,
          ${todoId}, ${runnerModel ?? null}
        FROM app.todos WHERE id = ${todoId} AND plan_id IS NULL
        ON CONFLICT(todo_id) DO NOTHING
        RETURNING id
      `);
    const created = inserted.rows[0] ?? null;
    const existing = created
      ? null
      : await transaction.execute<{ id: number }>(sql`
            SELECT id FROM app.plans WHERE todo_id = ${todoId}
          `);
    const planId = created?.id ?? existing?.rows[0]?.id;
    if (!planId) return null;

    for (const [position, repositoryId] of repositoryIds.entries()) {
      await transaction.execute(sql`
          INSERT INTO app.plan_repositories (plan_id, repository_id, position)
          VALUES (${planId}, ${repositoryId}, ${position})
          ON CONFLICT(plan_id, repository_id) DO NOTHING
        `);
    }
    await transaction.execute(sql`
        UPDATE app.todos SET plan_id = ${planId}
        WHERE id = ${todoId} AND (plan_id IS NULL OR plan_id = ${planId})
      `);
    return { planId, created: created !== null };
  });
}

// Change the task's model after start. Propagates to its already-created
// features (they snapshot the plan value at approval) so retries and fix
// runs pick it up; runs already in flight keep the model they launched with.
export async function setTaskRunnerModel(planId: number, model: string): Promise<void> {
  await withTransaction(async (transaction) => {
    await transaction.execute(sql`
        UPDATE app.plans SET runner_model = ${model} WHERE id = ${planId}
      `);
    await transaction.execute(sql`
        UPDATE app.features SET runner_model = ${model} WHERE plan_id = ${planId}
      `);
  });
}

export async function getPlan(id: number): Promise<PlanRow | null> {
  return queryOne<PlanRow>(sql`SELECT * FROM app.plans WHERE id = ${id}`);
}

export interface PlanWithRepo extends PlanRow {
  owner: string;
  name: string;
  installation_id: number;
  pr_number: number | null; // from the linked feature, if generation started
  feature_status: string | null; // the linked feature's lifecycle status
  feature_error: string | null; // its failure detail, when generation failed
  verification_status: string | null; // latest verification for the feature
  verification_results: CriterionResult[] | null;
  verification_demo: { video?: string; caption?: string } | null;
}

// Plans across the given installations, newest first, with repo + generated-PR
// context for the dashboard.
export async function listPlansForInstallations(
  installationIds: number[],
  limit = 50,
): Promise<PlanWithRepo[]> {
  if (installationIds.length === 0) return [];
  return queryRows<PlanWithRepo>(sql`
    SELECT p.*, r.owner, r.name, r.installation_id, f.pr_number,
      f.status AS feature_status, f.error AS feature_error,
      v.status AS verification_status, v.results AS verification_results,
      v.demo AS verification_demo
    FROM app.plans p
    JOIN app.repositories r ON r.id = p.repository_id
    LEFT JOIN app.features f ON f.id = p.feature_id
    LEFT JOIN app.verifications v ON v.id = (
      SELECT MAX(id) FROM app.verifications WHERE feature_id = p.feature_id
    )
    WHERE r.installation_id = ANY(${bigintArray(installationIds)})
    ORDER BY p.id DESC
    LIMIT ${limit}
  `);
}

// One plan with the same repo/feature/verification context as the list query
// (the board's task-detail view).
export async function getPlanWithRepoById(id: number): Promise<PlanWithRepo | null> {
  return queryOne<PlanWithRepo>(sql`
    SELECT p.*, r.owner, r.name, r.installation_id, f.pr_number,
      f.status AS feature_status, f.error AS feature_error,
      v.status AS verification_status, v.results AS verification_results,
      v.demo AS verification_demo
    FROM app.plans p
    JOIN app.repositories r ON r.id = p.repository_id
    LEFT JOIN app.features f ON f.id = p.feature_id
    LEFT JOIN app.verifications v ON v.id = (
      SELECT MAX(id) FROM app.verifications WHERE feature_id = p.feature_id
    )
    WHERE p.id = ${id}
  `);
}

export async function updatePlan(
  id: number,
  fields: {
    status?: string;
    analysis?: string;
    questions?: ApiPlanQuestion[];
    answers?: string[];
    plan?: string;
    summary?: string;
    acceptance?: string[];
    featureId?: number;
    error?: string;
    tier?: string;
    feedback?: string;
  },
): Promise<void> {
  await execute(sql`
    UPDATE app.plans SET
      status = COALESCE(${fields.status ?? null}::text, status),
      analysis = COALESCE(${fields.analysis ?? null}::text, analysis),
      questions = COALESCE(${fields.questions ? JSON.stringify(fields.questions) : null}::jsonb, questions),
      answers = COALESCE(${fields.answers ? JSON.stringify(fields.answers) : null}::jsonb, answers),
      plan = COALESCE(${fields.plan ?? null}::text, plan),
      summary = COALESCE(${fields.summary ?? null}::text, summary),
      acceptance = COALESCE(${fields.acceptance ? JSON.stringify(fields.acceptance) : null}::jsonb, acceptance),
      feature_id = COALESCE(${fields.featureId ?? null}::bigint, feature_id),
      error = COALESCE(${fields.error ?? null}::text, error),
      tier = COALESCE(${fields.tier ?? null}::text, tier),
      feedback = COALESCE(${fields.feedback ?? null}::text, feedback)
    WHERE id = ${id}
  `);
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
  await execute(sql`
    INSERT INTO app.push_subscriptions (user_github_id, endpoint, p256dh, auth)
    VALUES (${userGithubId}, ${sub.endpoint}, ${sub.p256dh}, ${sub.auth})
    ON CONFLICT(endpoint) DO UPDATE SET
      user_github_id = excluded.user_github_id,
      p256dh = excluded.p256dh,
      auth = excluded.auth
  `);
}

// Scoped to the calling user so one user can't delete another's subscription
// by guessing an endpoint.
export async function deletePushSubscriptionByEndpoint(
  userGithubId: number,
  endpoint: string,
): Promise<void> {
  await execute(sql`
    DELETE FROM app.push_subscriptions
    WHERE user_github_id = ${userGithubId} AND endpoint = ${endpoint}
  `);
}

export async function listPushSubscriptionsForUser(
  userGithubId: number,
): Promise<PushSubscriptionRow[]> {
  return queryRows<PushSubscriptionRow>(sql`
    SELECT * FROM app.push_subscriptions WHERE user_github_id = ${userGithubId}
  `);
}

// Used by the send path to prune expired endpoints (410/404 responses).
export async function deletePushSubscriptionById(id: number): Promise<void> {
  await execute(sql`DELETE FROM app.push_subscriptions WHERE id = ${id}`);
}

export async function finishFixAttempt(
  id: number,
  status: string,
  commitSha?: string,
  error?: string,
  usage?: CliUsage,
): Promise<void> {
  await execute(sql`
    UPDATE app.fix_attempts SET
      status = ${status}, commit_sha = ${commitSha ?? null}, error = ${error ?? null},
      input_tokens = ${usage?.inputTokens ?? 0}, output_tokens = ${usage?.outputTokens ?? 0},
      cache_read_tokens = ${usage?.cacheReadTokens ?? 0},
      cache_write_tokens = ${usage?.cacheWriteTokens ?? 0},
      cost_usd = ${usage?.costUsd ?? 0}, model = ${usage?.model ?? null}
    WHERE id = ${id}
  `);
}

// Claims the (agent, repo, PR) instance for a new dispatch. agent_instance_id
// is deterministic per (agent, repo, PR) and intentionally reused across
// re-reviews (see dispatchReviewAgent), so two concurrent/redelivered
// dispatches for the same instance must never both insert a 'running' row —
// every completion/usage write resolves "the row to update" by instance id +
// status='running', so a duplicate row causes writes to land on the wrong
// dispatch. Mirrors tryRecordFixAttempt / tryRecordAutomationRun: sweep stale
// rows in the same transaction, then let the partial unique index guard the
// insert. Returns null when
// another dispatch for this exact instance is already in flight. The sweep
// threshold is STALL_AFTER_MINUTES (shared/time.ts), the same cutoff that
// drives the 'stalled' UI label.
export async function tryRecordReview(
  repositoryId: number,
  installationId: number,
  prNumber: number,
  trigger: string,
  agentSlug: string,
  agentInstanceId: string,
  riskTier: string | null = null,
  stageRunId: number | null = null,
  headSha: string | null = null,
): Promise<number | null> {
  return withTransaction(async (transaction) => {
    await transaction.execute(sql`
        UPDATE app.reviews SET status = 'failed', completed_at = CURRENT_TIMESTAMP,
          error = COALESCE(error, 'stalled: no completion before a replacement was admitted')
        WHERE agent_instance_id = ${agentInstanceId} AND status = 'running'
          AND created_at < ${minutesAgo(STALL_AFTER_MINUTES)}
      `);
    const result = await transaction.execute<{ id: number }>(sql`
        INSERT INTO app.reviews
          (repository_id, installation_id, pr_number, trigger_event, status,
           agent_slug, agent_instance_id, risk_tier, stage_run_id, head_sha)
        VALUES (${repositoryId}, ${installationId}, ${prNumber}, ${trigger},
          'running', ${agentSlug}, ${agentInstanceId}, ${riskTier}, ${stageRunId}, ${headSha})
        ON CONFLICT DO NOTHING
        RETURNING id
      `);
    return result.rows[0]?.id ?? null;
  });
}

// Called by the post_review tool once the agent has published to GitHub.
// Keyed by the exact agent instance so concurrent agents reviewing the same
// PR can never complete each other's rows. `findingPaths` are the files the
// findings anchored to; the push re-review policy reads them back.
export async function completeReview(
  agentInstanceId: string,
  reviewUrl: string | null,
  findingsCount: number | null = null,
  verdict: 'approve' | 'comment' | 'request_changes' = 'comment',
  findingPaths: string[] | null = null,
): Promise<{ stage_run_id: number | null } | null> {
  return queryOne<{ stage_run_id: number | null }>(sql`
    UPDATE app.reviews SET status = 'completed', completed_at = CURRENT_TIMESTAMP,
      review_url = ${reviewUrl}, findings_count = ${findingsCount}, verdict = ${verdict},
      finding_paths = ${findingPaths === null ? null : JSON.stringify(findingPaths)}::jsonb
    WHERE id = (
      SELECT id FROM app.reviews
      WHERE agent_instance_id = ${agentInstanceId} AND status = 'running'
      ORDER BY id DESC LIMIT 1
    )
    RETURNING stage_run_id
  `);
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
  await execute(sql`
    UPDATE app.reviews SET
      input_tokens = input_tokens + ${usage.inputTokens},
      output_tokens = output_tokens + ${usage.outputTokens},
      cache_read_tokens = cache_read_tokens + ${usage.cacheReadTokens},
      cache_write_tokens = cache_write_tokens + ${usage.cacheWriteTokens},
      cost_usd = cost_usd + ${usage.costUsd}, model = ${usage.model}
    WHERE id = (
      SELECT id FROM app.reviews WHERE agent_instance_id = ${agentInstanceId}
      ORDER BY id DESC LIMIT 1
    )
  `);
}
