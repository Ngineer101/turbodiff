import { sql } from 'drizzle-orm';
import { STALL_CUTOFF_MODIFIER } from '../shared/time.ts';
import { execute, queryOne, queryRows } from './database.ts';

function idList(ids: number[]) {
  return sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
}

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
    WHERE installation_id IN (${idList(installationIds)})
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
  risk_tier: string | null; // null before tiering, and on mention/manual dispatch
  findings_count: number | null; // null until post_review completes the row
  repo_owner: string | null; // null if the repo was since removed
  repo_name: string | null;
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
    WHERE r.installation_id IN (${idList(installationIds)})
    ORDER BY r.id DESC
    LIMIT ${limit} OFFSET ${offset}
  `);
}

export async function countReviews(installationIds: number[]): Promise<number> {
  if (installationIds.length === 0) return 0;
  const row = await queryOne<{ n: number }>(sql`
    SELECT COUNT(*) AS n FROM app.reviews WHERE installation_id IN (${idList(installationIds)})
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
    WHERE installation_id IN (${idList(installationIds)})
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
    WHERE r.installation_id IN (${idList(installationIds)})
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
          AND created_at > CURRENT_TIMESTAMP + ${STALL_CUTOFF_MODIFIER}::interval
      ) AS running
    FROM app.reviews
    WHERE installation_id IN (${idList(installationIds)})
  `);
  return row ?? empty;
}

// Marks the latest still-running review for an agent instance as failed.
// Fired from the metering subscriber when the agent's submission settles
// without post_review having completed the row (agent error, abort, or a run
// that never posted). No-op when the row is already completed.
export async function markReviewFailed(agentInstanceId: string): Promise<void> {
  await execute(sql`
    UPDATE app.reviews SET status = 'failed', completed_at = CURRENT_TIMESTAMP
    WHERE id = (
      SELECT id FROM app.reviews
      WHERE agent_instance_id = ${agentInstanceId} AND status = 'running'
      ORDER BY id DESC LIMIT 1
    )
  `);
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
      AND created_at > CURRENT_TIMESTAMP + ${STALL_CUTOFF_MODIFIER}::interval
    LIMIT 1
  `);
  return row !== null;
}

// True when this agent reviewed (or started reviewing) this PR within the
// window, regardless of outcome. Backs the push-trigger debounce: a burst of
// pushes re-dispatches at most once per window per agent.
export async function reviewedRecently(
  repositoryId: number,
  prNumber: number,
  agentSlug: string,
  windowMinutes: number,
): Promise<boolean> {
  const row = await queryOne<{ id: number }>(sql`
    SELECT id FROM app.reviews
    WHERE repository_id = ${repositoryId} AND pr_number = ${prNumber}
      AND agent_slug = ${agentSlug}
      AND created_at > CURRENT_TIMESTAMP - (${windowMinutes}::double precision * INTERVAL '1 minute')
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
