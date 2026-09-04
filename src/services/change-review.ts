import {
  getInstallation,
  hasActiveReview,
  lastReviewedHead,
  latestCompletedReviewsByAgent,
  listAgentsForRepo,
  type AgentRow,
  type ChangeRow,
  type RepositoryRow,
} from '../data/db.ts';
import {
  agentsForTier,
  computePushDelta,
  computeRiskTier,
  remainingDailyBudget,
  selectAgentsForPush,
  tierModelOverride,
  type PushDelta,
  type PushSelection,
  type RiskTier,
} from './review-policy.ts';

export type DispatchOptions = {
  riskTier?: string;
  modelOverride?: string;
  stageRunId?: number;
  // The change head this dispatch reviews; recorded on the review row.
  headSha?: string;
  // On a push re-review: what changed since the agent last looked, handed to
  // the agent as its focus.
  delta?: { sinceHead: string; files: string[] };
};

export type ReviewDispatcher = (
  agent: AgentRow,
  repo: RepositoryRow,
  prNumber: number,
  prUrl: string,
  trigger: string,
  opts?: DispatchOptions,
) => Promise<boolean>;

export type SkippedAgent = { slug: string; reason: string };

export type ChangeReviewDispatchResult =
  | {
      kind: 'dispatched';
      tier: RiskTier;
      agents: string[];
      sinceHead: string | null;
      skipped: SkippedAgent[];
    }
  // A push where no agent needs another look: every earlier verdict stands.
  | { kind: 'nothing_to_do'; reason: string; tier: RiskTier; skipped: SkippedAgent[] }
  | { kind: 'skipped'; reason: string }
  | { kind: 'failed'; reason: string };

// A push re-review: the head the stage was scheduled for, and how to diff it
// against the last reviewed head (injectable so tests never reach GitHub).
export type PushReviewContext = {
  headSha: string;
  computeDelta: typeof computePushDelta;
};

export async function dispatchChangeReviews(
  change: ChangeRow,
  repo: RepositoryRow,
  trigger: string,
  dispatch: ReviewDispatcher,
  computeRisk: typeof computeRiskTier = computeRiskTier,
  push?: PushReviewContext,
  stageRunId?: number,
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

  // A push is tiered on what it added since the last reviewed head; anything
  // else (or a push whose delta can't be trusted) is tiered on the whole change.
  let delta: PushDelta | null = null;
  if (push) {
    const sinceHead = await lastReviewedHead(repo.id, change.number);
    if (sinceHead) {
      delta = await push.computeDelta(
        repo.installation_id,
        repo.owner,
        repo.name,
        sinceHead,
        push.headSha,
      );
    }
  }
  let tier: RiskTier = 'full';
  if (delta) tier = delta.tier;
  else {
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
  }

  let selection: PushSelection<AgentRow>;
  if (push) {
    const priors = (await latestCompletedReviewsByAgent(repo.id, change.number)).map((prior) => ({
      agentSlug: prior.agent_slug,
      verdict: prior.verdict,
      findingPaths: prior.finding_paths ?? [],
    }));
    selection = selectAgentsForPush(enabled, priors, delta, tier);
  } else {
    selection = { agents: agentsForTier(tier, enabled), skipped: [], tier };
  }
  const modelOverride = tierModelOverride(selection.tier);

  let agents = selection.agents;
  const skipped = [...selection.skipped];
  if (push) {
    // An agent still on an earlier head of this change can't take a second
    // dispatch (one running row per instance); it sees the live PR anyway.
    const idle: AgentRow[] = [];
    for (const agent of agents) {
      if (await hasActiveReview(repo.id, change.number, agent.slug)) {
        skipped.push({ slug: agent.slug, reason: 'still reviewing an earlier push' });
      } else idle.push(agent);
    }
    agents = idle;
    if (agents.length === 0) {
      return {
        kind: 'nothing_to_do',
        reason:
          selection.agents.length === 0
            ? 'no agent needs to re-review this push'
            : 'every selected agent is still reviewing an earlier push',
        tier: selection.tier,
        skipped,
      };
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

  const headSha = push?.headSha ?? change.source_head;
  const dispatched: string[] = [];
  const url =
    change.external_url ?? `https://github.com/${repo.owner}/${repo.name}/pull/${change.number}`;
  for (const agent of agents.slice(0, budget)) {
    const options: DispatchOptions = { riskTier: selection.tier };
    if (modelOverride) options.modelOverride = modelOverride;
    if (stageRunId !== undefined) options.stageRunId = stageRunId;
    if (headSha) options.headSha = headSha;
    if (delta) {
      options.delta = { sinceHead: delta.sinceHead, files: delta.files.map((f) => f.filename) };
    }
    if (await dispatch(agent, repo, change.number, url, trigger, options)) {
      dispatched.push(agent.slug);
    }
  }
  return dispatched.length > 0
    ? {
        kind: 'dispatched',
        tier: selection.tier,
        agents: dispatched,
        sinceHead: delta?.sinceHead ?? null,
        skipped,
      }
    : { kind: 'failed', reason: 'dispatch failed' };
}
