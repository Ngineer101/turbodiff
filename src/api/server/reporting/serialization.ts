import type {
  FeatureUsageRow,
  FixAttemptRow,
  ReviewActivityRow,
  VerificationRow,
} from '../../../data/db.ts';
import type { ApiFeatureUsage, ApiFeatureUsageSession } from '../../../shared/api-types.ts';
import { parseUtc, STALL_AFTER_MS } from '../../../shared/time.ts';
import { certificateUrl } from '../../../application/deliveries/certificates.ts';

function reviewState(review: ReviewActivityRow): 'running' | 'completed' | 'stalled' | 'failed' {
  if (review.status === 'failed') return 'failed';
  if (review.status !== 'running') return 'completed';
  return Date.now() - parseUtc(review.created_at) > STALL_AFTER_MS ? 'stalled' : 'running';
}

function totalTokens(row: {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}): number {
  return row.input_tokens + row.output_tokens + row.cache_read_tokens + row.cache_write_tokens;
}

export async function serializeFeatureUsage(
  feature: FeatureUsageRow,
  reviews: ReviewActivityRow[],
  fixes: FixAttemptRow[],
  verifications: VerificationRow[],
): Promise<ApiFeatureUsage> {
  const repository = `${feature.repo_owner}/${feature.repo_name}`;
  const pullRequestUrl =
    feature.pr_number === null
      ? null
      : `https://github.com/${repository}/pull/${feature.pr_number}`;
  const sessions: ApiFeatureUsageSession[] = [];
  if (feature.cost_usd > 0 || feature.model !== null) {
    sessions.push({
      kind: 'generate',
      label: 'generate',
      status: feature.status,
      cost_usd: feature.cost_usd,
      total_tokens: totalTokens(feature),
      duration_s: null,
      created_at: feature.created_at,
      url: pullRequestUrl,
    });
  }
  for (const review of reviews) {
    sessions.push({
      kind: 'review',
      label: review.agent_slug ?? 'review',
      status: reviewState(review),
      cost_usd: review.cost_usd,
      total_tokens: totalTokens(review),
      duration_s:
        review.completed_at === null
          ? null
          : (parseUtc(review.completed_at) - parseUtc(review.created_at)) / 1000,
      created_at: review.created_at,
      url: review.review_url,
    });
  }
  for (const fix of fixes) {
    sessions.push({
      kind: 'fix',
      label: fix.trigger,
      status: fix.status,
      cost_usd: fix.cost_usd,
      total_tokens: totalTokens(fix),
      duration_s: null,
      created_at: fix.created_at,
      url: pullRequestUrl,
    });
  }
  for (const verification of verifications) {
    sessions.push({
      kind: 'verify',
      label: 'verify',
      status: verification.status,
      cost_usd: verification.cost_usd,
      total_tokens: totalTokens(verification),
      duration_s: null,
      created_at: verification.created_at,
      url: verification.status === 'passed' ? await certificateUrl(feature.id) : null,
    });
  }
  sessions.sort((left, right) => parseUtc(left.created_at) - parseUtc(right.created_at));
  return {
    id: feature.id,
    title: feature.title,
    repo: repository,
    status: feature.status,
    pr_number: feature.pr_number,
    pr_url: pullRequestUrl,
    created_at: feature.created_at,
    total_cost_usd: sessions.reduce((sum, session) => sum + session.cost_usd, 0),
    total_tokens: sessions.reduce((sum, session) => sum + session.total_tokens, 0),
    sessions,
  };
}

export function groupByRepoPr<T extends { repository_id: number; pr_number: number }>(
  rows: T[],
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = `${row.repository_id}:${row.pr_number}`;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  return groups;
}
