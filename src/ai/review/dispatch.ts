import { dispatch } from '@flue/runtime';
import {
  listRepoConnections,
  markReviewFailed,
  tryRecordReview,
  type AgentRow,
  type RepositoryRow,
} from '../../data/db.ts';
import { connectionSnapshot } from '../../services/connections.ts';
import { PrReviewer } from '../agents/pr-reviewer.ts';

// Application boundary between webhook policy and the durable reviewer agent.
// It owns admission, the non-secret delivery snapshot, and dispatch failure
// cleanup; HTTP routes only call this use case.
export async function dispatchReviewAgent(
  agent: AgentRow,
  repo: RepositoryRow,
  prNumber: number,
  prUrl: string,
  trigger: string,
  opts: {
    riskTier?: string;
    modelOverride?: string;
    // Present for native change requests (docs/artifacts-provider.md): the
    // same agent runs, with CR-backed tools swapped in by the pin.
    changeRequest?: { id: number; number: number };
  } = {},
): Promise<boolean> {
  const instanceId = (
    opts.changeRequest
      ? `${agent.slug}--${repo.owner}--${repo.name}--cr-${opts.changeRequest.number}`
      : `${agent.slug}--${repo.owner}--${repo.name}--${prNumber}`
  ).toLowerCase();
  const reviewId = await tryRecordReview(
    repo.id,
    repo.installation_id,
    prNumber,
    trigger,
    agent.slug,
    instanceId,
    opts.riskTier ?? null,
  );
  if (reviewId === null) return false;

  const connections = (await listRepoConnections(repo.id, 'reviews')).map(connectionSnapshot);
  const baseAttributes = {
    agent_slug: agent.slug,
    agent_name: agent.name,
    model: opts.modelOverride ?? agent.model,
    ...(opts.changeRequest
      ? {
          change_request: `${repo.owner}/${repo.name}#${opts.changeRequest.number}`,
          change_request_id: String(opts.changeRequest.id),
        }
      : { pull_request: `${repo.owner}/${repo.name}#${prNumber}` }),
    trigger,
  };
  const attributes =
    connections.length > 0
      ? { ...baseAttributes, connections: JSON.stringify(connections) }
      : baseAttributes;

  try {
    await dispatch(PrReviewer, {
      id: instanceId,
      message: {
        kind: 'signal',
        type: 'review.request',
        tagName: 'review-request',
        attributes,
        body:
          (opts.changeRequest
            ? `Review change request #${opts.changeRequest.number} in ${repo.owner}/${repo.name} (${prUrl}) and post your review with the post_review tool.\n\n`
            : `Review pull request #${prNumber} in ${repo.owner}/${repo.name} (${prUrl}) and post your review to GitHub.\n\n`) +
          `Agent focus — ${agent.name}:\n${agent.instructions}`,
      },
    });
  } catch (error) {
    console.error(
      `turbodiff: dispatch failed for ${instanceId} (${agent.slug} on ${repo.owner}/${repo.name}#${prNumber}):`,
      error,
    );
    await markReviewFailed(instanceId);
    return false;
  }
  return true;
}
