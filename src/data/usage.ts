import { env } from 'cloudflare:workers';
import { placeholderList } from './sql.ts';
import type { VerificationRow } from './factory.ts';
import type { ReviewActivityRow } from './reviews.ts';

// --- Usage page (Phase 3 redesign): features-shipped accordion + pipeline-wide cost ---

export interface FeatureUsageRow {
  id: number;
  repository_id: number;
  repo_owner: string;
  repo_name: string;
  title: string;
  status: string;
  pr_number: number | null;
  created_at: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  model: string | null;
}

// Features across the caller's installations, newest first, with the
// feature's own generation usage — the accordion's top-level rows. Legacy
// reviews with no matching feature (pre-factory or human-opened PRs) simply
// have nothing to attach to and never surface here.
export async function listRecentFeaturesForUsage(
  installationIds: number[],
  limit = 20,
): Promise<FeatureUsageRow[]> {
  if (installationIds.length === 0) return [];
  const placeholders = placeholderList(installationIds.length, 2);
  const res = await env.DB.prepare(
    `SELECT f.id, f.repository_id, repo.owner AS repo_owner, repo.name AS repo_name,
		        f.title, f.status, f.pr_number, f.created_at,
		        f.input_tokens, f.output_tokens, f.cache_read_tokens, f.cache_write_tokens,
		        f.cost_usd, f.model
		 FROM features f
		 JOIN repositories repo ON repo.id = f.repository_id
		 WHERE repo.installation_id IN (${placeholders})
		 ORDER BY f.id DESC
		 LIMIT ?1`,
  )
    .bind(limit, ...installationIds)
    .all<FeatureUsageRow>();
  return res.results;
}

// Reviews/fix attempts belonging to any of the given (repository, PR) pairs.
// D1/SQLite has no clean tuple-IN, so this over-fetches by repo id and PR
// number separately; the caller groups results down to the exact pairs. The
// candidate set is bounded by listRecentFeaturesForUsage's limit, so the
// over-fetch is cheap.
export async function listReviewsForRepoPrs(
  pairs: { repositoryId: number; prNumber: number }[],
): Promise<ReviewActivityRow[]> {
  if (pairs.length === 0) return [];
  const repoIds = [...new Set(pairs.map((p) => p.repositoryId))];
  const prNumbers = [...new Set(pairs.map((p) => p.prNumber))];
  const repoPlaceholders = placeholderList(repoIds.length);
  const prPlaceholders = placeholderList(prNumbers.length, repoIds.length + 1);
  const res = await env.DB.prepare(
    `SELECT r.*, repo.owner AS repo_owner, repo.name AS repo_name
		 FROM reviews r
		 LEFT JOIN repositories repo ON repo.id = r.repository_id
		 WHERE r.repository_id IN (${repoPlaceholders}) AND r.pr_number IN (${prPlaceholders})
		 ORDER BY r.created_at ASC`,
  )
    .bind(...repoIds, ...prNumbers)
    .all<ReviewActivityRow>();
  return res.results;
}

export interface FixAttemptRow {
  id: number;
  repository_id: number;
  pr_number: number;
  trigger: string;
  status: string;
  commit_sha: string | null;
  error: string | null;
  created_at: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  model: string | null;
}

export async function listFixAttemptsForRepoPrs(
  pairs: { repositoryId: number; prNumber: number }[],
): Promise<FixAttemptRow[]> {
  if (pairs.length === 0) return [];
  const repoIds = [...new Set(pairs.map((p) => p.repositoryId))];
  const prNumbers = [...new Set(pairs.map((p) => p.prNumber))];
  const repoPlaceholders = placeholderList(repoIds.length);
  const prPlaceholders = placeholderList(prNumbers.length, repoIds.length + 1);
  const res = await env.DB.prepare(
    `SELECT id, repository_id, pr_number, "trigger", status, commit_sha, error, created_at,
		        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, model
		 FROM fix_attempts
		 WHERE repository_id IN (${repoPlaceholders}) AND pr_number IN (${prPlaceholders})
		 ORDER BY created_at ASC`,
  )
    .bind(...repoIds, ...prNumbers)
    .all<FixAttemptRow>();
  return res.results;
}

export async function listVerificationsForFeatures(
  featureIds: number[],
): Promise<VerificationRow[]> {
  if (featureIds.length === 0) return [];
  const placeholders = placeholderList(featureIds.length);
  const res = await env.DB.prepare(
    `SELECT * FROM verifications WHERE feature_id IN (${placeholders}) ORDER BY created_at ASC`,
  )
    .bind(...featureIds)
    .all<VerificationRow>();
  return res.results;
}

export interface AutomationUsageRow {
  automation_id: number;
  name: string;
  repo_owner: string;
  repo_name: string;
  runs: number;
  cost_usd: number;
}

// Per-automation cost for one 'YYYY-MM' month, costliest first — only
// automations that actually fired that month appear (mirrors
// agentUsageForMonth's grouping).
export async function automationUsageForMonth(
  installationIds: number[],
  month: string,
): Promise<AutomationUsageRow[]> {
  if (installationIds.length === 0) return [];
  const placeholders = placeholderList(installationIds.length);
  const res = await env.DB.prepare(
    `SELECT a.id AS automation_id, a.name, repo.owner AS repo_owner, repo.name AS repo_name,
		        COUNT(ar.id) AS runs, COALESCE(SUM(ar.cost_usd), 0) AS cost_usd
		 FROM automations a
		 JOIN repositories repo ON repo.id = a.repository_id
		 JOIN automation_runs ar
		   ON ar.automation_id = a.id AND strftime('%Y-%m', ar.created_at) = ?${installationIds.length + 1}
		 WHERE repo.installation_id IN (${placeholders})
		 GROUP BY a.id
		 ORDER BY cost_usd DESC`,
  )
    .bind(...installationIds, month)
    .all<AutomationUsageRow>();
  return res.results;
}

// The five metered pipeline stages, each reduced to (month, cost) and unioned
// into ONE statement: /api/board polls while tasks are live, so five separate
// round-trips per poll was five times the D1 row-read bill for the same total.
// Reviews scope on reviews.installation_id; every other stage reaches an
// installation through repositories (equivalent — a review's repository always
// belongs to the same installation). Each leg pre-aggregates by month, so the
// union materialises at most five rows per month rather than one row per event.
function pipelineCostUnion(installationIds: number[]): { sql: string; binds: number[] } {
  const scope = (leg: number) =>
    placeholderList(installationIds.length, leg * installationIds.length + 1);
  const legs = [
    `SELECT strftime('%Y-%m', r.created_at) AS month, SUM(r.cost_usd) AS cost
			 FROM reviews r
			 WHERE r.installation_id IN (${scope(0)})
			 GROUP BY month`,
    `SELECT strftime('%Y-%m', f.created_at) AS month, SUM(f.cost_usd) AS cost
			 FROM features f
			 JOIN repositories repo ON repo.id = f.repository_id
			 WHERE repo.installation_id IN (${scope(1)})
			 GROUP BY month`,
    `SELECT strftime('%Y-%m', fa.created_at) AS month, SUM(fa.cost_usd) AS cost
			 FROM fix_attempts fa
			 JOIN repositories repo ON repo.id = fa.repository_id
			 WHERE repo.installation_id IN (${scope(2)})
			 GROUP BY month`,
    `SELECT strftime('%Y-%m', v.created_at) AS month, SUM(v.cost_usd) AS cost
			 FROM verifications v
			 JOIN features f ON f.id = v.feature_id
			 JOIN repositories repo ON repo.id = f.repository_id
			 WHERE repo.installation_id IN (${scope(3)})
			 GROUP BY month`,
    `SELECT strftime('%Y-%m', ar.created_at) AS month, SUM(ar.cost_usd) AS cost
			 FROM automation_runs ar
			 JOIN automations a ON a.id = ar.automation_id
			 JOIN repositories repo ON repo.id = a.repository_id
			 WHERE repo.installation_id IN (${scope(4)})
			 GROUP BY month`,
  ];
  return {
    sql: legs.join('\n UNION ALL\n'),
    binds: legs.flatMap(() => installationIds),
  };
}

// Pipeline-wide cost for one 'YYYY-MM' month: review + generation + fix +
// verification + automation. Plan-stage agent spend is not metered anywhere
// (the plans table has no cost columns), so this is "pipeline cost", not
// "everything you spent".
export async function pipelineCostForMonth(
  installationIds: number[],
  month: string,
): Promise<number> {
  if (installationIds.length === 0) return 0;
  const { sql, binds } = pipelineCostUnion(installationIds);
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(cost), 0) AS cost_usd FROM (${sql}) legs WHERE month = ?${binds.length + 1}`,
  )
    .bind(...binds, month)
    .first<{ cost_usd: number }>();
  return row?.cost_usd ?? 0;
}

export interface PipelineMonthCostRow {
  month: string; // 'YYYY-MM' (UTC)
  cost_usd: number;
}

// The same aggregate, grouped — backs the usage page's cost-by-month table so
// its current-month row equals the headline tile by construction. `months` is
// inlined into the SQL exactly like monthlyUsage: a caller-side literal, never
// request input.
export async function pipelineCostByMonth(
  installationIds: number[],
  months = 6,
): Promise<PipelineMonthCostRow[]> {
  if (installationIds.length === 0) return [];
  const { sql, binds } = pipelineCostUnion(installationIds);
  const res = await env.DB.prepare(
    `SELECT month, COALESCE(SUM(cost), 0) AS cost_usd FROM (${sql}) legs
			 GROUP BY month
			 ORDER BY month DESC
			 LIMIT ${months}`,
  )
    .bind(...binds)
    .all<PipelineMonthCostRow>();
  return res.results;
}
