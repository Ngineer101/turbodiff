import { env } from 'cloudflare:workers';
import { githubJson, githubRequest as gh } from '../integrations/github/client.ts';
import { installationToken } from '../integrations/github/app.ts';
import { reviewCountLastDay } from '../data/db.ts';
import {
  computeRiskTierFromFiles,
  type PushDelta,
  type RiskFileEntry,
  type RiskTier,
} from '../domain/review-selection.ts';

// The network-facing half of review dispatch policy: fetching what GitHub
// knows about a change and feeding it to the pure classification in
// domain/review-selection.ts, plus the installation-wide daily budget.
export {
  agentsForTier,
  computeRiskTierFromFiles,
  selectAgentsForPush,
} from '../domain/review-selection.ts';
export type {
  PriorReview,
  PushDelta,
  PushSelection,
  RiskFileEntry,
  RiskTier,
} from '../domain/review-selection.ts';

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
  // SAFETY: gh() throws on non-2xx, and GitHub's "list pull request files"
  // response is an array whose items always carry filename, additions, and
  // deletions.
  const files = (await res.json()) as RiskFileEntry[];
  return computeRiskTierFromFiles(files);
}

interface CompareResponse {
  behind_by: number;
  // Present for comparisons under GitHub's size limits; capped at 300
  // entries, comfortably past the count that already makes a tier 'full'.
  files?: RiskFileEntry[];
}

// What a push added since the last reviewed head, tiered on its own. Null
// whenever the delta can't be trusted, and the caller falls back to tiering
// the whole change: the old head is gone (force push), or the branch was
// rebased so the compare's merge base dropped to the branch point and the
// "delta" would be the whole change plus base churn.
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
    // Three-dot compare: the commits `headSha` adds on top of its merge base
    // with `sinceHead`. When the old head is an ancestor (a plain push) that
    // is exactly the pushed commits.
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

// Optional cheap-model override for trivial reviews. TRIVIAL_MODEL is a
// gateway model id in wrangler.jsonc vars; empty disables the downgrade and
// trivial reviews run each agent's configured model.
export function tierModelOverride(tier: RiskTier): string | undefined {
  return tier === 'trivial' && env.TRIVIAL_MODEL ? env.TRIVIAL_MODEL : undefined;
}

// Agent-runs left under the installation's rolling daily cap — the shared
// admission control for review dispatch, GitHub webhooks and native change
// requests alike (each selected agent consumes one unit).
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
