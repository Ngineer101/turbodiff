import { env } from 'cloudflare:workers';
import { githubJson, githubRequest as gh } from '../../integrations/github/client.ts';
import { installationToken } from '../../integrations/github/app.ts';
import { reviewCountLastDay } from '../../data/db.ts';
import {
  computeRiskTierFromFiles,
  type PushDelta,
  type RiskFileEntry,
  type RiskTier,
} from '../../domain/review-selection.ts';

export {
  agentsForTier,
  computeRiskTierFromFiles,
  selectAgentsForPush,
} from '../../domain/review-selection.ts';
export type {
  PriorReview,
  PushDelta,
  PushSelection,
  RiskFileEntry,
  RiskTier,
} from '../../domain/review-selection.ts';

export async function computeRiskTier(
  installationId: number,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<RiskTier> {
  const token = await installationToken(installationId);
  // One page suffices: at 50+ files the tier is already 'full', so anything
  // past the first 100 can't change the answer.
  const res = await gh(token, `/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100`);
  // SAFETY: GitHub's successful list-files response matches RiskFileEntry[].
  const files = (await res.json()) as RiskFileEntry[];
  return computeRiskTierFromFiles(files);
}

interface CompareResponse {
  behind_by: number;
  // Present for comparisons under GitHub's size limits; capped at 300
  // entries, comfortably past the count that already makes a tier 'full'.
  files?: RiskFileEntry[];
}

export async function computePushDelta(
  installationId: number,
  owner: string,
  repo: string,
  sinceHead: string,
  headSha: string,
): Promise<PushDelta | null> {
  if (sinceHead === headSha) return null;
  try {
    const token = await installationToken(installationId);
    const compare = await githubJson<CompareResponse>(
      token,
      `/repos/${owner}/${repo}/compare/${sinceHead}...${headSha}`,
    );
    if (compare.behind_by > 0 || !compare.files) {
      console.warn(
        JSON.stringify({
          event: 'review_push_delta_unusable',
          repository: `${owner}/${repo}`,
          since_head: sinceHead,
          head_sha: headSha,
          behind_by: compare.behind_by,
        }),
      );
      return null;
    }
    return { sinceHead, files: compare.files, tier: computeRiskTierFromFiles(compare.files) };
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'review_push_delta_failed',
        repository: `${owner}/${repo}`,
        since_head: sinceHead,
        head_sha: headSha,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return null;
  }
}

export function tierModelOverride(tier: RiskTier): string | undefined {
  return tier === 'trivial' && env.TRIVIAL_MODEL ? env.TRIVIAL_MODEL : undefined;
}

export async function remainingDailyBudget(
  installationId: number,
  accountLabel: string,
): Promise<number> {
  const limit = Number(env.REVIEW_DAILY_LIMIT) || 50;
  const used = await reviewCountLastDay(installationId);
  const remaining = limit - used;
  if (remaining <= 0) {
    console.warn(
      `turbodiff: daily review cap (${limit}) reached for installation ${installationId} (${accountLabel})`,
    );
  }
  return remaining;
}
