import {
  getInstallation,
  hasActiveReview,
  listAgentsForRepo,
  reviewedRecently,
  type AgentRow,
  type ChangeRow,
  type RepositoryRow,
} from '../data/db.ts';
import {
  agentsForTier,
  computeRiskTier,
  remainingDailyBudget,
  tierModelOverride,
  type RiskTier,
} from './review-policy.ts';

export type DispatchOptions = { riskTier?: string; modelOverride?: string };

export type ReviewDispatcher = (
  agent: AgentRow,
  repo: RepositoryRow,
  prNumber: number,
  prUrl: string,
  trigger: string,
  opts?: DispatchOptions,
) => Promise<boolean>;

export type ChangeReviewDispatchResult =
  | { kind: 'dispatched'; tier: RiskTier; agents: string[] }
  | { kind: 'skipped'; reason: string }
  | { kind: 'failed'; reason: string };

const PUSH_DEBOUNCE_MINUTES = 10;

export async function dispatchChangeReviews(
  change: ChangeRow,
  repo: RepositoryRow,
  trigger: string,
  dispatch: ReviewDispatcher,
  computeRisk: typeof computeRiskTier = computeRiskTier,
  debounce = false,
): Promise<ChangeReviewDispatchResult> {
  if (change.status !== 'open') return { kind: 'skipped', reason: 'change is not open' };
  if (change.draft) return { kind: 'skipped', reason: 'change is draft' };
  if (!change.capabilities.includes('read_change')) {
    return { kind: 'skipped', reason: 'provider cannot read the change' };
  }
  if (!change.capabilities.includes('publish_review')) {
    return { kind: 'skipped', reason: 'provider cannot publish a review' };
  }
  if (!repo.enabled) return { kind: 'skipped', reason: 'factory disabled for repo' };

  const installation = await getInstallation(repo.installation_id);
  if (!installation || installation.suspended) {
    return { kind: 'skipped', reason: 'installation missing or suspended' };
  }

  const enabled = (await listAgentsForRepo(repo)).filter((agent) => agent.enabled);
  if (enabled.length === 0) return { kind: 'skipped', reason: 'no agents enabled' };

  let tier: RiskTier = 'full';
  try {
    tier = await computeRisk(repo.installation_id, repo.owner, repo.name, change.number);
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'review_risk_tier_failed',
        repository_id: repo.id,
        change_id: change.id,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
  let agents = agentsForTier(tier, enabled);
  const modelOverride = tierModelOverride(tier);

  if (debounce) {
    const idle: typeof agents = [];
    for (const agent of agents) {
      const busy =
        (await hasActiveReview(repo.id, change.number, agent.slug)) ||
        (await reviewedRecently(repo.id, change.number, agent.slug, PUSH_DEBOUNCE_MINUTES));
      if (!busy) idle.push(agent);
    }
    agents = idle;
    if (agents.length === 0) {
      return { kind: 'skipped', reason: 'all agents busy or within push debounce' };
    }
  }

  const budget = await remainingDailyBudget(repo.installation_id, installation.account_login);
  if (budget <= 0) return { kind: 'skipped', reason: 'daily review limit reached' };
  if (agents.length > budget) {
    console.warn(
      JSON.stringify({
        event: 'review_budget_truncated',
        repository_id: repo.id,
        change_id: change.id,
        available: budget,
        requested: agents.length,
      }),
    );
  }

  const dispatched: string[] = [];
  const url =
    change.external_url ?? `https://github.com/${repo.owner}/${repo.name}/pull/${change.number}`;
  for (const agent of agents.slice(0, budget)) {
    const options: DispatchOptions = { riskTier: tier };
    if (modelOverride) options.modelOverride = modelOverride;
    if (await dispatch(agent, repo, change.number, url, trigger, options)) {
      dispatched.push(agent.slug);
    }
  }
  return dispatched.length > 0
    ? { kind: 'dispatched', tier, agents: dispatched }
    : { kind: 'failed', reason: 'dispatch failed' };
}
