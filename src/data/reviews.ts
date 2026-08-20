import { env } from 'cloudflare:workers';

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
  const placeholders = installationIds.map((_, i) => `?${i + 1}`).join(', ');
  const res = await env.DB.prepare(
    `SELECT agent_slug, COUNT(*) AS reviews, SUM(cost_usd) AS cost_usd
		 FROM reviews
		 WHERE installation_id IN (${placeholders})
			AND strftime('%Y-%m', created_at) = ?${installationIds.length + 1}
		 GROUP BY agent_slug
		 ORDER BY cost_usd DESC`,
  )
    .bind(...installationIds, month)
    .all<AgentUsageRow>();
  return res.results;
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
  const placeholders = installationIds.map((_, i) => `?${i + 1}`).join(', ');
  const res = await env.DB.prepare(
    `SELECT r.*, repo.owner AS repo_owner, repo.name AS repo_name
		 FROM reviews r
		 LEFT JOIN repositories repo ON repo.id = r.repository_id
		 WHERE r.installation_id IN (${placeholders})
		 ORDER BY r.id DESC
		 LIMIT ${limit} OFFSET ${offset}`,
  )
    .bind(...installationIds)
    .all<ReviewActivityRow>();
  return res.results;
}

export async function countReviews(installationIds: number[]): Promise<number> {
  if (installationIds.length === 0) return 0;
  const placeholders = installationIds.map((_, i) => `?${i + 1}`).join(', ');
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM reviews WHERE installation_id IN (${placeholders})`,
  )
    .bind(...installationIds)
    .first<{ n: number }>();
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
  const placeholders = installationIds.map((_, i) => `?${i + 1}`).join(', ');
  const res = await env.DB.prepare(
    `SELECT strftime('%Y-%m', created_at) AS month,
			COUNT(*) AS reviews,
			SUM(status = 'completed') AS completed,
			SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS total_tokens,
			SUM(cost_usd) AS cost_usd
		 FROM reviews
		 WHERE installation_id IN (${placeholders})
		 GROUP BY month
		 ORDER BY month DESC
		 LIMIT ${months}`,
  )
    .bind(...installationIds)
    .all<MonthlyUsageRow>();
  return res.results;
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
  const placeholders = installationIds.map((_, i) => `?${i + 1}`).join(', ');
  const res = await env.DB.prepare(
    `SELECT r.repository_id,
			repo.owner AS repo_owner, repo.name AS repo_name,
			COUNT(*) AS reviews,
			SUM(r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_tokens) AS total_tokens,
			SUM(r.cost_usd) AS cost_usd
		 FROM reviews r
		 LEFT JOIN repositories repo ON repo.id = r.repository_id
		 WHERE r.installation_id IN (${placeholders})
			AND strftime('%Y-%m', r.created_at) = ?${installationIds.length + 1}
		 GROUP BY r.repository_id
		 ORDER BY cost_usd DESC`,
  )
    .bind(...installationIds, month)
    .all<RepoUsageRow>();
  return res.results;
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
  const placeholders = installationIds.map((_, i) => `?${i + 1}`).join(', ');
  // `running` counts only dispatches younger than the 20-minute stall window
  // (STALL_AFTER_MS in routes/api.ts): a review row flips out of 'running'
  // solely when its agent posts, so a run that dies mid-flight would
  // otherwise pin the dashboard's active count forever.
  const row = await env.DB.prepare(
    `SELECT
			COALESCE(SUM(strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')), 0) AS month_reviews,
			COALESCE(SUM(CASE WHEN strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now') THEN cost_usd ELSE 0 END), 0) AS month_cost_usd,
			COALESCE(SUM(CASE WHEN strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
				THEN input_tokens + output_tokens + cache_read_tokens + cache_write_tokens ELSE 0 END), 0) AS month_tokens,
			AVG(CASE WHEN status = 'completed' AND completed_at IS NOT NULL
				AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
				THEN (julianday(completed_at) - julianday(created_at)) * 86400 END) AS avg_duration_s,
			AVG(CASE WHEN status = 'completed' AND findings_count IS NOT NULL
				AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
				THEN findings_count END) AS avg_findings,
			COALESCE(SUM(status = 'running'
				AND created_at > datetime('now', '-20 minutes')), 0) AS running
		 FROM reviews
		 WHERE installation_id IN (${placeholders})`,
  )
    .bind(...installationIds)
    .first<DashboardStats>();
  return row ?? empty;
}

// Marks the latest still-running review for an agent instance as failed.
// Fired from the metering subscriber when the agent's submission settles
// without post_review having completed the row (agent error, abort, or a run
// that never posted). No-op when the row is already completed.
export async function markReviewFailed(agentInstanceId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE reviews SET status = 'failed', completed_at = datetime('now')
		 WHERE id = (
			SELECT id FROM reviews WHERE agent_instance_id = ?1 AND status = 'running'
			ORDER BY id DESC LIMIT 1
		 )`,
  )
    .bind(agentInstanceId)
    .run();
}

// True when this agent's review of this PR is running and young enough to
// still be live (older running rows are presumed dead — the /reviews stall
// rule). Backs mention-trigger dedupe so a re-tag can't double-dispatch.
export async function hasActiveReview(
  repositoryId: number,
  prNumber: number,
  agentSlug: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT id FROM reviews
		 WHERE repository_id = ?1 AND pr_number = ?2 AND agent_slug = ?3
			AND status = 'running' AND created_at > datetime('now', '-20 minutes')
		 LIMIT 1`,
  )
    .bind(repositoryId, prNumber, agentSlug)
    .first<{ id: number }>();
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
  const row = await env.DB.prepare(
    `SELECT id FROM reviews
		 WHERE repository_id = ?1 AND pr_number = ?2 AND agent_slug = ?3
			AND created_at > datetime('now', '-' || ?4 || ' minutes')
		 LIMIT 1`,
  )
    .bind(repositoryId, prNumber, agentSlug, windowMinutes)
    .first<{ id: number }>();
  return row !== null;
}

// Reviews dispatched for this installation in the last 24h (backs the daily cap).
export async function reviewCountLastDay(installationId: number): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM reviews
		 WHERE installation_id = ?1 AND created_at > datetime('now', '-1 day')`,
  )
    .bind(installationId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
