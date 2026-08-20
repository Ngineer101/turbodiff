import { env } from 'cloudflare:workers';
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
  const placeholders = installationIds.map((_, i) => `?${i + 2}`).join(', ');
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
  const repoPlaceholders = repoIds.map((_, i) => `?${i + 1}`).join(', ');
  const prPlaceholders = prNumbers.map((_, i) => `?${repoIds.length + i + 1}`).join(', ');
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
  const repoPlaceholders = repoIds.map((_, i) => `?${i + 1}`).join(', ');
  const prPlaceholders = prNumbers.map((_, i) => `?${repoIds.length + i + 1}`).join(', ');
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
  const placeholders = featureIds.map((_, i) => `?${i + 1}`).join(', ');
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
  const placeholders = installationIds.map((_, i) => `?${i + 1}`).join(', ');
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

// Pipeline-wide cost for one 'YYYY-MM' month: review + generation + fix +
// verification + automation, each a small single-purpose query (matching
// dashboardStats/monthlyUsage/repoUsageForMonth's style) rather than one
// UNION, summed here.
export async function pipelineCostForMonth(
  installationIds: number[],
  month: string,
): Promise<number> {
  if (installationIds.length === 0) return 0;
  const placeholders = installationIds.map((_, i) => `?${i + 1}`).join(', ');
  const monthParam = `?${installationIds.length + 1}`;
  const bind = (stmt: D1PreparedStatement) => stmt.bind(...installationIds, month);
  const [reviews, generation, fixes, verifications, automations] = await Promise.all([
    bind(
      env.DB.prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) AS cost FROM reviews
			 WHERE installation_id IN (${placeholders}) AND strftime('%Y-%m', created_at) = ${monthParam}`,
      ),
    ).first<{ cost: number }>(),
    bind(
      env.DB.prepare(
        `SELECT COALESCE(SUM(f.cost_usd), 0) AS cost FROM features f
			 JOIN repositories repo ON repo.id = f.repository_id
			 WHERE repo.installation_id IN (${placeholders}) AND strftime('%Y-%m', f.created_at) = ${monthParam}`,
      ),
    ).first<{ cost: number }>(),
    bind(
      env.DB.prepare(
        `SELECT COALESCE(SUM(fa.cost_usd), 0) AS cost FROM fix_attempts fa
			 JOIN repositories repo ON repo.id = fa.repository_id
			 WHERE repo.installation_id IN (${placeholders}) AND strftime('%Y-%m', fa.created_at) = ${monthParam}`,
      ),
    ).first<{ cost: number }>(),
    bind(
      env.DB.prepare(
        `SELECT COALESCE(SUM(v.cost_usd), 0) AS cost FROM verifications v
			 JOIN features f ON f.id = v.feature_id
			 JOIN repositories repo ON repo.id = f.repository_id
			 WHERE repo.installation_id IN (${placeholders}) AND strftime('%Y-%m', v.created_at) = ${monthParam}`,
      ),
    ).first<{ cost: number }>(),
    bind(
      env.DB.prepare(
        `SELECT COALESCE(SUM(ar.cost_usd), 0) AS cost FROM automation_runs ar
			 JOIN automations a ON a.id = ar.automation_id
			 JOIN repositories repo ON repo.id = a.repository_id
			 WHERE repo.installation_id IN (${placeholders}) AND strftime('%Y-%m', ar.created_at) = ${monthParam}`,
      ),
    ).first<{ cost: number }>(),
  ]);
  return (
    (reviews?.cost ?? 0) +
    (generation?.cost ?? 0) +
    (fixes?.cost ?? 0) +
    (verifications?.cost ?? 0) +
    (automations?.cost ?? 0)
  );
}
