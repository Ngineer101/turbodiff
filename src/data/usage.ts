import { sql, type SQL } from 'drizzle-orm';
import type { VerificationRow } from './factory.ts';
import { queryOne, queryRows } from './database.ts';
import type { ReviewActivityRow } from './reviews.ts';
import { bigintArray } from './sql.ts';

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
  return queryRows<FeatureUsageRow>(sql`
    SELECT f.id, f.repository_id, repo.owner AS repo_owner, repo.name AS repo_name,
      f.title, f.status, f.pr_number, f.created_at,
      f.input_tokens, f.output_tokens, f.cache_read_tokens, f.cache_write_tokens,
      f.cost_usd, f.model
    FROM app.features f
    JOIN app.repositories repo ON repo.id = f.repository_id
    WHERE repo.installation_id = ANY(${bigintArray(installationIds)})
    ORDER BY f.id DESC
    LIMIT ${limit}
  `);
}

function distinctRepoPrPairs(
  pairs: { repositoryId: number; prNumber: number }[],
): { repositoryId: number; prNumber: number }[] {
  return [
    ...new Map(pairs.map((pair) => [`${pair.repositoryId}:${pair.prNumber}`, pair])).values(),
  ];
}

function repoPrTupleList(pairs: { repositoryId: number; prNumber: number }[]): SQL {
  return sql.join(
    pairs.map((pair) => sql`(${pair.repositoryId}, ${pair.prNumber})`),
    sql`, `,
  );
}

// PostgreSQL row constructors constrain these queries to the exact
// (repository, PR) pairs instead of a broader Cartesian candidate set.
export async function listReviewsForRepoPrs(
  pairs: { repositoryId: number; prNumber: number }[],
): Promise<ReviewActivityRow[]> {
  if (pairs.length === 0) return [];
  const distinct = distinctRepoPrPairs(pairs);
  return queryRows<ReviewActivityRow>(sql`
    SELECT r.*, repo.owner AS repo_owner, repo.name AS repo_name
    FROM app.reviews r
    LEFT JOIN app.repositories repo ON repo.id = r.repository_id
    WHERE (r.repository_id, r.pr_number) IN (${repoPrTupleList(distinct)})
    ORDER BY r.created_at ASC
  `);
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
  const distinct = distinctRepoPrPairs(pairs);
  return queryRows<FixAttemptRow>(sql`
    SELECT id, repository_id, pr_number, "trigger", status, commit_sha, error, created_at,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, model
    FROM app.fix_attempts
    WHERE (repository_id, pr_number) IN (${repoPrTupleList(distinct)})
    ORDER BY created_at ASC
  `);
}

export async function listVerificationsForFeatures(
  featureIds: number[],
): Promise<VerificationRow[]> {
  if (featureIds.length === 0) return [];
  return queryRows<VerificationRow>(sql`
    SELECT * FROM app.verifications
    WHERE feature_id = ANY(${bigintArray(featureIds)}) ORDER BY created_at ASC
  `);
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
  return queryRows<AutomationUsageRow>(sql`
    SELECT a.id AS automation_id, a.name,
      repo.owner AS repo_owner, repo.name AS repo_name,
      COUNT(ar.id) AS runs, COALESCE(SUM(ar.cost_usd), 0) AS cost_usd
    FROM app.automations a
    JOIN app.repositories repo ON repo.id = a.repository_id
    JOIN app.automation_runs ar
      ON ar.automation_id = a.id
      AND to_char(ar.created_at AT TIME ZONE 'UTC', 'YYYY-MM') = ${month}
    WHERE repo.installation_id = ANY(${bigintArray(installationIds)})
    GROUP BY a.id, a.name, repo.owner, repo.name
    ORDER BY cost_usd DESC
  `);
}

// The five metered pipeline stages, each reduced to (month, cost) and unioned
// into ONE statement: /api/board polls while tasks are live, so five separate
// round-trips per poll was five times the PostgreSQL row-read bill for the same total.
// Reviews scope on reviews.installation_id; every other stage reaches an
// installation through repositories (equivalent — a review's repository always
// belongs to the same installation). Each leg pre-aggregates by month, so the
// union materialises at most five rows per month rather than one row per event.
function pipelineCostUnion(installationIds: number[]): SQL {
  return sql`
    SELECT to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM') AS month,
      SUM(r.cost_usd) AS cost
    FROM app.reviews r
    WHERE r.installation_id = ANY(${bigintArray(installationIds)})
    GROUP BY month
    UNION ALL
    SELECT to_char(f.created_at AT TIME ZONE 'UTC', 'YYYY-MM') AS month,
      SUM(f.cost_usd) AS cost
    FROM app.features f
    JOIN app.repositories repo ON repo.id = f.repository_id
    WHERE repo.installation_id = ANY(${bigintArray(installationIds)})
    GROUP BY month
    UNION ALL
    SELECT to_char(fa.created_at AT TIME ZONE 'UTC', 'YYYY-MM') AS month,
      SUM(fa.cost_usd) AS cost
    FROM app.fix_attempts fa
    JOIN app.repositories repo ON repo.id = fa.repository_id
    WHERE repo.installation_id = ANY(${bigintArray(installationIds)})
    GROUP BY month
    UNION ALL
    SELECT to_char(v.created_at AT TIME ZONE 'UTC', 'YYYY-MM') AS month,
      SUM(v.cost_usd) AS cost
    FROM app.verifications v
    JOIN app.features f ON f.id = v.feature_id
    JOIN app.repositories repo ON repo.id = f.repository_id
    WHERE repo.installation_id = ANY(${bigintArray(installationIds)})
    GROUP BY month
    UNION ALL
    SELECT to_char(ar.created_at AT TIME ZONE 'UTC', 'YYYY-MM') AS month,
      SUM(ar.cost_usd) AS cost
    FROM app.automation_runs ar
    JOIN app.automations a ON a.id = ar.automation_id
    JOIN app.repositories repo ON repo.id = a.repository_id
    WHERE repo.installation_id = ANY(${bigintArray(installationIds)})
    GROUP BY month
  `;
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
  const union = pipelineCostUnion(installationIds);
  const row = await queryOne<{ cost_usd: number }>(sql`
    SELECT COALESCE(SUM(cost), 0) AS cost_usd FROM (${union}) legs WHERE month = ${month}
  `);
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
  const union = pipelineCostUnion(installationIds);
  return queryRows<PipelineMonthCostRow>(sql`
    SELECT month, COALESCE(SUM(cost), 0) AS cost_usd FROM (${union}) legs
    GROUP BY month
    ORDER BY month DESC
    LIMIT ${months}
  `);
}
