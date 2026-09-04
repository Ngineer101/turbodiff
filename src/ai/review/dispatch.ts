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

// How many changed paths a push re-review names outright; past this the
// agent gets a count and works from the diff.
const FOCUS_PATH_CAP = 50;

// The re-review focus appended to a push dispatch: what moved since the
// agent's last look, so it reconciles rather than re-reads the whole change.
function pushFocus(delta: { sinceHead: string; files: string[] }): string {
  const shown = delta.files.slice(0, FOCUS_PATH_CAP);
  const more = delta.files.length - shown.length;
  return (
    `\n\nRe-review after a push. Files changed since your last review (head ${delta.sinceHead.slice(0, 7)}) — ` +
    'prioritise these and reconcile your earlier findings; revisit other files only where these changes affect them:\n' +
    shown.map((path) => `- ${path}`).join('\n') +
    (more > 0 ? `\n- …and ${more} more` : '')
  );
}

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
    stageRunId?: number;
    // The change head under review; recorded so a later push can diff from it.
    headSha?: string;
    // Push re-review: what changed since this agent's last completed review.
    delta?: { sinceHead: string; files: string[] };
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
    opts.stageRunId ?? null,
    opts.headSha ?? null,
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
          `Agent focus — ${agent.name}:\n${agent.instructions}` +
          (opts.delta ? pushFocus(opts.delta) : ''),
      },
    });
  } catch (error) {
    console.error(
      `turbodiff: dispatch failed for ${instanceId} (${agent.slug} on ${repo.owner}/${repo.name}#${prNumber}):`,
      error,
    );
    await markReviewFailed(
      instanceId,
      `dispatch failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1_000),
    );
    return false;
  }
  return true;
}
