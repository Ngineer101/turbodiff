import { tryRecordReview, type AgentRow, type RepositoryRow } from '../../data/db.ts';
import { failLifecycleReviewById } from '../../services/lifecycle.ts';
import { startReviewWorkflow, type ReviewWorkflowParams } from '../workflows/review.ts';

// Admits one exact review run and starts the generic review Workflow. The
// database row is the idempotency boundary; the model receives typed input and
// returns a typed artifact inside the Workflow.
export async function dispatchReviewAgent(
  agent: AgentRow,
  repo: RepositoryRow,
  prNumber: number,
  trigger: string,
  opts: {
    riskTier?: string;
    modelOverride?: string;
    stageRunId?: number;
    headSha?: string;
    delta?: { sinceHead: string; files: string[] };
    changeRequest?: { id: number; number: number };
  } = {},
): Promise<boolean> {
  if (!opts.headSha) {
    console.error(`turbodiff: refusing to start ${agent.slug} review without an exact head`);
    return false;
  }
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
    opts.headSha,
  );
  if (reviewId === null) return false;

  const params: ReviewWorkflowParams = {
    reviewId,
    repositoryId: repo.id,
    expectedRevision: opts.headSha,
    model: opts.modelOverride ?? agent.model,
    focus: { name: agent.name, instructions: agent.instructions },
    changedSincePreviousReview: opts.delta
      ? { revision: opts.delta.sinceHead, paths: opts.delta.files }
      : null,
    target: opts.changeRequest
      ? {
          kind: 'artifacts',
          number: opts.changeRequest.number,
          changeRequestId: opts.changeRequest.id,
        }
      : { kind: 'github', number: prNumber },
  };

  try {
    await startReviewWorkflow(params);
    return true;
  } catch (error) {
    const reason = `workflow start failed: ${error instanceof Error ? error.message : String(error)}`;
    console.error(
      `turbodiff: review workflow start failed for ${agent.slug} on ${repo.owner}/${repo.name}#${prNumber}:`,
      error,
    );
    await failLifecycleReviewById(reviewId, reason.slice(0, 1_000));
    return false;
  }
}
