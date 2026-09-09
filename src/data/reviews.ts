import { sql } from 'drizzle-orm';
import { STALL_AFTER_MINUTES } from '../shared/time.ts';
import type { CandidateFinding, FindingDecision } from '../domain/review-verification.ts';
import type { ReviewConclusion } from '../domain/review-context.ts';
import { execute, queryOne, queryRows, withTransaction } from './database.ts';
import { bigintArray, minutesAgo } from './sql.ts';

export interface AgentUsageRow {
  agent_slug: string | null;
  reviews: number;
  cost_usd: number;
}

// Cost per agent for one 'YYYY-MM' month, costliest first. NULL slug groups
// reviews recorded before multi-agent support.
export async function agentUsageForMonth(
  installationIds: number[],
  month: string,
): Promise<AgentUsageRow[]> {
  if (installationIds.length === 0) return [];
  return queryRows<AgentUsageRow>(sql`
    SELECT agent_slug, COUNT(*) AS reviews, SUM(cost_usd) AS cost_usd
    FROM app.reviews
    WHERE installation_id = ANY(${bigintArray(installationIds)})
      AND to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM') = ${month}
    GROUP BY agent_slug
    ORDER BY cost_usd DESC
  `);
}

export interface ReviewActivityRow {
  id: number;
  repository_id: number;
  installation_id: number;
  pr_number: number;
  trigger_event: string;
  status: string;
  created_at: string;
  completed_at: string | null;
  review_url: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  model: string | null;
  agent_slug: string | null; // null on rows predating multi-agent support
  agent_instance_id: string | null;
  submission_id: string | null;
  risk_tier: string | null; // null before tiering, and on mention/manual dispatch
  findings_count: number | null; // null until post_review completes the row
  stage_run_id: number | null;
  verdict: string | null;
  conclusion: ReviewConclusion | null;
  coverage_status: 'complete' | 'incomplete' | 'stale' | null;
  reviewable_file_count: number | null;
  covered_file_count: number | null;
  missing_paths: string[] | null;
  coverage_head_sha: string | null;
  published_head_sha: string | null;
  error: string | null; // why a failed row failed
  repo_owner: string | null; // null if the repo was since removed
  repo_name: string | null;
}

export type ReviewVerificationStatus = 'skipped' | 'completed' | 'failed' | 'incomplete';
export type ReviewFindingFeedback = 'useful' | 'false_positive' | 'fixed' | 'dismissed';

export interface ReviewQualityRecord {
  candidates: CandidateFinding[];
  decisions: FindingDecision[];
  publishedCandidateIndexes: number[];
  status: ReviewVerificationStatus;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number | null;
  experimentKey: string | null;
}

export interface ReviewRunGuard {
  id: number;
  repository_id: number;
  pr_number: number;
  status: string;
  head_sha: string | null;
  submission_id: string | null;
}

export interface ReviewFileEvidenceRow {
  path: string;
  patch_delivered: boolean;
  disposition: 'reviewed' | 'blocked' | null;
  evidence: string | null;
}

export interface ReviewFileAcknowledgement {
  path: string;
  disposition: 'reviewed' | 'blocked';
  evidence: string;
}

export async function getReviewRunGuard(reviewId: number): Promise<ReviewRunGuard | null> {
  return queryOne<ReviewRunGuard>(sql`
    SELECT id, repository_id, pr_number, status, head_sha, submission_id
    FROM app.reviews WHERE id = ${reviewId}
  `);
}

export async function recordReviewPatchDelivery(reviewId: number, paths: string[]): Promise<void> {
  const uniquePaths = [...new Set(paths)];
  if (uniquePaths.length === 0) return;
  const values = uniquePaths.map((path) => sql`(${reviewId}, ${path}, TRUE, CURRENT_TIMESTAMP)`);
  await execute(sql`
    INSERT INTO app.review_file_evidence (review_id, path, patch_delivered, delivered_at)
    VALUES ${sql.join(values, sql`, `)}
    ON CONFLICT (review_id, path) DO UPDATE SET
      patch_delivered = TRUE,
      delivered_at = COALESCE(app.review_file_evidence.delivered_at, EXCLUDED.delivered_at)
  `);
}

export async function recordReviewFileAcknowledgements(
  reviewId: number,
  acknowledgements: ReviewFileAcknowledgement[],
): Promise<void> {
  const unique = [
    ...new Map(
      acknowledgements.map((acknowledgement) => [acknowledgement.path, acknowledgement]),
    ).values(),
  ];
  if (unique.length === 0) return;
  const values = unique.map(
    (item) =>
      sql`(${reviewId}, ${item.path}, ${item.disposition}, ${item.evidence}, CURRENT_TIMESTAMP)`,
  );
  await execute(sql`
    INSERT INTO app.review_file_evidence
      (review_id, path, disposition, evidence, acknowledged_at)
    VALUES ${sql.join(values, sql`, `)}
    ON CONFLICT (review_id, path) DO UPDATE SET
      disposition = EXCLUDED.disposition,
      evidence = EXCLUDED.evidence,
      acknowledged_at = EXCLUDED.acknowledged_at
  `);
}

export async function listReviewFileEvidence(reviewId: number): Promise<ReviewFileEvidenceRow[]> {
  return queryRows<ReviewFileEvidenceRow>(sql`
    SELECT path, patch_delivered, disposition, evidence
    FROM app.review_file_evidence
    WHERE review_id = ${reviewId}
    ORDER BY path
  `);
}

export async function recordReviewQuality(
  agentInstanceId: string,
  quality: ReviewQualityRecord,
): Promise<void> {
  await withTransaction(async (transaction) => {
    const found = await transaction.execute<{ id: number }>(sql`
      SELECT id FROM app.reviews
      WHERE agent_instance_id = ${agentInstanceId} AND status = 'running'
      ORDER BY id DESC LIMIT 1 FOR UPDATE
    `);
    const reviewId = found.rows[0]?.id;
    if (!reviewId) return;
    await transaction.execute(sql`
      UPDATE app.reviews SET
        candidate_count = ${quality.candidates.length},
        verification_status = ${quality.status},
        verification_model = ${quality.model},
        verification_input_tokens = ${quality.inputTokens},
        verification_output_tokens = ${quality.outputTokens},
        verification_cost_usd = ${quality.costUsd},
        verification_latency_ms = ${quality.latencyMs},
        experiment_key = ${quality.experimentKey}
      WHERE id = ${reviewId}
    `);
    await transaction.execute(sql`DELETE FROM app.review_findings WHERE review_id = ${reviewId}`);
    if (quality.candidates.length === 0) return;
    const published = new Set(quality.publishedCandidateIndexes);
    const decisions = new Map(quality.decisions.map((decision) => [decision.candidate, decision]));
    const values = quality.candidates.map((candidate, index) => {
      const decision = decisions.get(index);
      return sql`(
        ${reviewId}, ${index}, ${candidate.path}, ${candidate.line}, ${candidate.side},
        ${candidate.severity}, ${candidate.body}, ${candidate.evidence}, ${candidate.failurePath},
        ${published.has(index)}, ${decision?.confidence ?? null}, ${decision?.severity ?? null},
        ${decision?.reason ?? null}
      )`;
    });
    await transaction.execute(sql`
      INSERT INTO app.review_findings
        (review_id, candidate_index, path, line, side, severity, body, evidence, failure_path,
         published, verifier_confidence, verifier_severity, verification_reason)
      VALUES ${sql.join(values, sql`, `)}
    `);
  });
}

// Exact-run variant used by dispatched reviews. Re-review conversations reuse
// their agent instance id, so production writes must never select "latest".
export async function recordReviewQualityById(
  reviewId: number,
  quality: ReviewQualityRecord,
): Promise<void> {
  await withTransaction(async (transaction) => {
    const found = await transaction.execute<{ id: number }>(sql`
      SELECT id FROM app.reviews
      WHERE id = ${reviewId} AND status = 'running'
      FOR UPDATE
    `);
    if (!found.rows[0]) return;
    await transaction.execute(sql`
      UPDATE app.reviews SET
        candidate_count = ${quality.candidates.length},
        verification_status = ${quality.status},
        verification_model = ${quality.model},
        verification_input_tokens = ${quality.inputTokens},
        verification_output_tokens = ${quality.outputTokens},
        verification_cost_usd = ${quality.costUsd},
        verification_latency_ms = ${quality.latencyMs},
        experiment_key = ${quality.experimentKey}
      WHERE id = ${reviewId} AND status = 'running'
    `);
    await transaction.execute(sql`DELETE FROM app.review_findings WHERE review_id = ${reviewId}`);
    if (quality.candidates.length === 0) return;
    const published = new Set(quality.publishedCandidateIndexes);
    const decisions = new Map(quality.decisions.map((decision) => [decision.candidate, decision]));
    const values = quality.candidates.map((candidate, index) => {
      const decision = decisions.get(index);
      return sql`(
        ${reviewId}, ${index}, ${candidate.path}, ${candidate.line}, ${candidate.side},
        ${candidate.severity}, ${candidate.body}, ${candidate.evidence}, ${candidate.failurePath},
        ${published.has(index)}, ${decision?.confidence ?? null}, ${decision?.severity ?? null},
        ${decision?.reason ?? null}
      )`;
    });
    await transaction.execute(sql`
      INSERT INTO app.review_findings
        (review_id, candidate_index, path, line, side, severity, body, evidence, failure_path,
         published, verifier_confidence, verifier_severity, verification_reason)
      VALUES ${sql.join(values, sql`, `)}
    `);
  });
}

export interface ReviewQualityFindingRow {
  id: number;
  review_id: number;
  repo: string | null;
  pr_number: number;
  agent_slug: string | null;
  path: string;
  line: number;
  severity: 'P1' | 'P2';
  body: string;
  verification_reason: string | null;
  feedback: ReviewFindingFeedback | null;
  created_at: string;
}

export interface ReviewQualityStats {
  candidates: number;
  published: number;
  labeled: number;
  true_positives: number;
  false_positives: number;
  avg_verification_latency_ms: number | null;
  verification_cost_usd: number;
}

export async function reviewQualityDashboard(
  installationIds: number[],
): Promise<{ stats: ReviewQualityStats; findings: ReviewQualityFindingRow[] }> {
  const empty: ReviewQualityStats = {
    candidates: 0,
    published: 0,
    labeled: 0,
    true_positives: 0,
    false_positives: 0,
    avg_verification_latency_ms: null,
    verification_cost_usd: 0,
  };
  if (installationIds.length === 0) return { stats: empty, findings: [] };
  const ids = bigintArray(installationIds);
  const [reviewStats, findingStats, findings] = await Promise.all([
    queryOne<
      Pick<
        ReviewQualityStats,
        'candidates' | 'avg_verification_latency_ms' | 'verification_cost_usd'
      >
    >(sql`
      SELECT
        COALESCE(SUM(r.candidate_count), 0) AS candidates,
        AVG(r.verification_latency_ms) FILTER (
          WHERE r.verification_latency_ms IS NOT NULL
        ) AS avg_verification_latency_ms,
        COALESCE(SUM(r.verification_cost_usd), 0) AS verification_cost_usd
      FROM app.reviews r
      WHERE r.installation_id = ANY(${ids})
        AND r.created_at >= CURRENT_TIMESTAMP - INTERVAL '30 days'
    `),
    queryOne<
      Pick<ReviewQualityStats, 'published' | 'labeled' | 'true_positives' | 'false_positives'>
    >(sql`
      SELECT
        COUNT(f.id) AS published,
        COUNT(f.id) FILTER (WHERE f.feedback IS NOT NULL) AS labeled,
        COUNT(f.id) FILTER (WHERE f.feedback IN ('useful', 'fixed')) AS true_positives,
        COUNT(f.id) FILTER (WHERE f.feedback = 'false_positive') AS false_positives
      FROM app.review_findings f
      JOIN app.reviews r ON r.id = f.review_id
      WHERE r.installation_id = ANY(${ids}) AND f.published
        AND r.created_at >= CURRENT_TIMESTAMP - INTERVAL '30 days'
    `),
    queryRows<ReviewQualityFindingRow>(sql`
      SELECT f.id, f.review_id,
        CASE WHEN repo.id IS NULL THEN NULL ELSE repo.owner || '/' || repo.name END AS repo,
        r.pr_number, r.agent_slug, f.path, f.line, f.severity, f.body,
        f.verification_reason, f.feedback, f.created_at
      FROM app.review_findings f
      JOIN app.reviews r ON r.id = f.review_id
      LEFT JOIN app.repositories repo ON repo.id = r.repository_id
      WHERE r.installation_id = ANY(${ids}) AND f.published
      ORDER BY f.id DESC LIMIT 100
    `),
  ]);
  return {
    stats: { ...empty, ...reviewStats, ...findingStats },
    findings,
  };
}

export async function setReviewFindingFeedback(
  id: number,
  installationIds: number[],
  githubUserId: number,
  feedback: ReviewFindingFeedback,
): Promise<boolean> {
  if (installationIds.length === 0) return false;
  const result = await queryOne<{ id: number }>(sql`
    UPDATE app.review_findings f SET feedback = ${feedback},
      feedback_by_github_id = ${githubUserId}, feedback_at = CURRENT_TIMESTAMP
    FROM app.reviews r
    WHERE f.id = ${id} AND f.review_id = r.id AND f.published
      AND r.installation_id = ANY(${bigintArray(installationIds)})
    RETURNING f.id
  `);
  return result !== null;
}

export async function listRecentReviews(
  installationIds: number[],
  limit = 50,
  offset = 0,
): Promise<ReviewActivityRow[]> {
  if (installationIds.length === 0) return [];
  return queryRows<ReviewActivityRow>(sql`
    SELECT r.*, repo.owner AS repo_owner, repo.name AS repo_name
    FROM app.reviews r
    LEFT JOIN app.repositories repo ON repo.id = r.repository_id
    WHERE r.installation_id = ANY(${bigintArray(installationIds)})
    ORDER BY r.id DESC
    LIMIT ${limit} OFFSET ${offset}
  `);
}

export async function countReviews(installationIds: number[]): Promise<number> {
  if (installationIds.length === 0) return 0;
  const row = await queryOne<{ n: number }>(sql`
    SELECT COUNT(*) AS n FROM app.reviews
    WHERE installation_id = ANY(${bigintArray(installationIds)})
  `);
  return row?.n ?? 0;
}

export interface MonthlyUsageRow {
  month: string; // 'YYYY-MM' (UTC)
  reviews: number;
  completed: number;
  total_tokens: number;
  cost_usd: number;
}

export async function monthlyUsage(
  installationIds: number[],
  months = 6,
): Promise<MonthlyUsageRow[]> {
  if (installationIds.length === 0) return [];
  return queryRows<MonthlyUsageRow>(sql`
    SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM') AS month,
      COUNT(*) AS reviews,
      COUNT(*) FILTER (WHERE status = 'completed') AS completed,
      SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS total_tokens,
      SUM(cost_usd) AS cost_usd
    FROM app.reviews
    WHERE installation_id = ANY(${bigintArray(installationIds)})
    GROUP BY month
    ORDER BY month DESC
    LIMIT ${months}
  `);
}

export interface RepoUsageRow {
  repository_id: number;
  repo_owner: string | null;
  repo_name: string | null;
  reviews: number;
  total_tokens: number;
  cost_usd: number;
}

// Per-repo usage for one 'YYYY-MM' month, costliest first.
export async function repoUsageForMonth(
  installationIds: number[],
  month: string,
): Promise<RepoUsageRow[]> {
  if (installationIds.length === 0) return [];
  return queryRows<RepoUsageRow>(sql`
    SELECT r.repository_id,
      repo.owner AS repo_owner, repo.name AS repo_name,
      COUNT(*) AS reviews,
      SUM(r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_tokens) AS total_tokens,
      SUM(r.cost_usd) AS cost_usd
    FROM app.reviews r
    LEFT JOIN app.repositories repo ON repo.id = r.repository_id
    WHERE r.installation_id = ANY(${bigintArray(installationIds)})
      AND to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM') = ${month}
    GROUP BY r.repository_id, repo.owner, repo.name
    ORDER BY cost_usd DESC
  `);
}

export interface DashboardStats {
  month_reviews: number;
  month_cost_usd: number;
  month_tokens: number;
  avg_duration_s: number | null; // completed reviews this month
  avg_findings: number | null; // findings per completed review this month
  running: number;
}

export async function dashboardStats(installationIds: number[]): Promise<DashboardStats> {
  const empty: DashboardStats = {
    month_reviews: 0,
    month_cost_usd: 0,
    month_tokens: 0,
    avg_duration_s: null,
    avg_findings: null,
    running: 0,
  };
  if (installationIds.length === 0) return empty;
  // `running` counts only dispatches younger than the shared stall window
  // (STALL_AFTER_MS in shared/time.ts): a review row flips out of 'running'
  // solely when its agent posts, so a run that dies mid-flight would
  // otherwise pin the dashboard's active count forever.
  const row = await queryOne<DashboardStats>(sql`
    SELECT
      COUNT(*) FILTER (
        WHERE date_trunc('month', created_at) = date_trunc('month', CURRENT_TIMESTAMP)
      ) AS month_reviews,
      COALESCE(SUM(cost_usd) FILTER (
        WHERE date_trunc('month', created_at) = date_trunc('month', CURRENT_TIMESTAMP)
      ), 0) AS month_cost_usd,
      COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens)
        FILTER (
          WHERE date_trunc('month', created_at) = date_trunc('month', CURRENT_TIMESTAMP)
        ), 0) AS month_tokens,
      AVG(EXTRACT(EPOCH FROM (completed_at - created_at))) FILTER (
        WHERE status = 'completed' AND completed_at IS NOT NULL
          AND date_trunc('month', created_at) = date_trunc('month', CURRENT_TIMESTAMP)
      ) AS avg_duration_s,
      AVG(findings_count) FILTER (
        WHERE status = 'completed' AND findings_count IS NOT NULL
          AND date_trunc('month', created_at) = date_trunc('month', CURRENT_TIMESTAMP)
      ) AS avg_findings,
      COUNT(*) FILTER (
        WHERE status = 'running'
          AND created_at > ${minutesAgo(STALL_AFTER_MINUTES)}
      ) AS running
    FROM app.reviews
    WHERE installation_id = ANY(${bigintArray(installationIds)})
  `);
  return row ?? empty;
}

// Marks the latest still-running review for an agent instance as failed.
// Fired from the metering subscriber when the agent's submission settles
// without post_review having completed the row (agent error, abort, or a run
// that never posted). No-op when the row is already completed.
export async function markReviewFailed(
  agentInstanceId: string,
  // Why: the dispatch error or the agent's settlement error. Persisted so a
  // failed review is diagnosable from its row (live finding: every review
  // had died within seconds with zero tokens and nothing on record to say
  // why — the reason only ever reached the Worker log).
  error: string | null = null,
): Promise<{ stage_run_id: number | null } | null> {
  return queryOne<{ stage_run_id: number | null }>(sql`
    UPDATE app.reviews SET status = 'failed', completed_at = CURRENT_TIMESTAMP,
      error = COALESCE(${error}::text, error)
    WHERE id = (
      SELECT id FROM app.reviews
      WHERE agent_instance_id = ${agentInstanceId} AND status = 'running'
      ORDER BY id DESC LIMIT 1
    )
    RETURNING stage_run_id
  `);
}

export async function markReviewFailedById(
  reviewId: number,
  error: string | null = null,
): Promise<{ stage_run_id: number | null } | null> {
  return queryOne<{ stage_run_id: number | null }>(sql`
    UPDATE app.reviews SET status = 'failed', completed_at = CURRENT_TIMESTAMP,
      error = COALESCE(${error}::text, error)
    WHERE id = ${reviewId} AND status = 'running'
    RETURNING stage_run_id
  `);
}

export async function markReviewFailedBySubmission(
  submissionId: string,
  error: string | null = null,
): Promise<{ stage_run_id: number | null } | null> {
  return queryOne<{ stage_run_id: number | null }>(sql`
    UPDATE app.reviews SET status = 'failed', completed_at = CURRENT_TIMESTAMP,
      error = COALESCE(${error}::text, error)
    WHERE submission_id = ${submissionId} AND status = 'running'
    RETURNING stage_run_id
  `);
}

export async function bindReviewSubmission(reviewId: number, submissionId: string): Promise<void> {
  await execute(sql`
    UPDATE app.reviews SET submission_id = ${submissionId}
    WHERE id = ${reviewId} AND status = 'running' AND submission_id IS NULL
  `);
}

export interface ReviewStageProgress {
  running: number;
  completed: number;
  failed: number;
  blocking: boolean;
  inconclusive: number;
  // Recorded reasons of the failed reviews, oldest first.
  errors: string[];
}

export async function reviewStageProgress(stageRunId: number): Promise<ReviewStageProgress> {
  const row = await queryOne<ReviewStageProgress>(sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'running') AS running,
      COUNT(*) FILTER (WHERE status = 'completed') AS completed,
      COUNT(*) FILTER (WHERE status = 'failed') AS failed,
      COALESCE(BOOL_OR(conclusion = 'not_ready' OR verdict = 'request_changes'), FALSE) AS blocking,
      COUNT(*) FILTER (WHERE status = 'completed' AND conclusion = 'inconclusive') AS inconclusive,
      COALESCE(
        ARRAY_REMOVE(ARRAY_AGG(error ORDER BY id) FILTER (WHERE status = 'failed'), NULL),
        '{}'
      ) AS errors
    FROM app.reviews WHERE stage_run_id = ${stageRunId}
  `);
  return (
    row ?? {
      running: 0,
      completed: 0,
      failed: 0,
      blocking: false,
      inconclusive: 0,
      errors: [],
    }
  );
}

// True when this agent's review of this PR is running and young enough to
// still be live (older running rows are presumed dead — the /reviews stall
// rule). Backs mention-trigger dedupe so a re-tag can't double-dispatch.
export async function hasActiveReview(
  repositoryId: number,
  prNumber: number,
  agentSlug: string,
): Promise<boolean> {
  const row = await queryOne<{ id: number }>(sql`
    SELECT id FROM app.reviews
    WHERE repository_id = ${repositoryId} AND pr_number = ${prNumber}
      AND agent_slug = ${agentSlug} AND status = 'running'
      AND created_at > ${minutesAgo(STALL_AFTER_MINUTES)}
    LIMIT 1
  `);
  return row !== null;
}

export interface PriorAgentReview {
  agent_slug: string;
  verdict: 'approve' | 'comment' | 'request_changes';
  head_sha: string | null;
  finding_paths: string[] | null; // null on rows recorded before the column existed
  conclusion: ReviewConclusion | null;
}

// Each agent's most recent completed review of this PR — what a push
// re-review reconciles against (verdict + the files its findings anchored
// to). Running and failed rows never count: they concluded nothing.
export async function latestCompletedReviewsByAgent(
  repositoryId: number,
  prNumber: number,
): Promise<PriorAgentReview[]> {
  return queryRows<PriorAgentReview>(sql`
    SELECT DISTINCT ON (agent_slug) agent_slug, verdict, head_sha, finding_paths, conclusion
    FROM app.reviews
    WHERE repository_id = ${repositoryId} AND pr_number = ${prNumber}
      AND status = 'completed' AND agent_slug IS NOT NULL AND verdict IS NOT NULL
    ORDER BY agent_slug, id DESC
  `);
}

// The newest head any agent finished reviewing on this PR: the base a push
// re-review diffs from. Null when nothing completed yet, or only rows from
// before head tracking exist — callers then tier the whole PR as before.
export async function lastReviewedHead(
  repositoryId: number,
  prNumber: number,
): Promise<string | null> {
  const row = await queryOne<{ head_sha: string }>(sql`
    SELECT head_sha FROM app.reviews
    WHERE repository_id = ${repositoryId} AND pr_number = ${prNumber}
      AND status = 'completed' AND head_sha IS NOT NULL
    ORDER BY id DESC LIMIT 1
  `);
  return row?.head_sha ?? null;
}

// True when some agent already completed a review of exactly this head —
// a force-push back to a reviewed commit has nothing new to look at.
export async function headHasCompletedReview(
  repositoryId: number,
  prNumber: number,
  headSha: string,
): Promise<boolean> {
  const row = await queryOne<{ id: number }>(sql`
    SELECT id FROM app.reviews
    WHERE repository_id = ${repositoryId} AND pr_number = ${prNumber}
      AND status = 'completed' AND head_sha = ${headSha}
    LIMIT 1
  `);
  return row !== null;
}

// Reviews dispatched for this installation in the last 24h (backs the daily cap).
export async function reviewCountLastDay(installationId: number): Promise<number> {
  const row = await queryOne<{ n: number }>(sql`
    SELECT COUNT(*) AS n FROM app.reviews
    WHERE installation_id = ${installationId}
      AND created_at > CURRENT_TIMESTAMP - INTERVAL '1 day'
  `);
  return row?.n ?? 0;
}
