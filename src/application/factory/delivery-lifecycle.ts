import {
  getChange,
  getChangeRevision,
  latestChangeRevision,
  listReviewOutcomes,
  updateChangeStatus,
  type ChangeRow,
  type ChangeRevisionRow,
} from '../../data/changes.ts';
import { recordChangeCheck } from '../../data/change-checks.ts';
import {
  applyDeliveryDecision,
  completeDeliveryStage,
  deliveryRun,
  withDeliveryLock,
} from '../../data/delivery-lifecycle.ts';
import {
  listLifecycleEvents,
  listStageRuns,
  updateFactoryRunStatus,
  type FactoryRunRow,
  type StageRunRow,
} from '../../data/execution.ts';
import { getIntegration } from '../../data/integrations.ts';
import { getRepository, type RepositoryRow } from '../../data/repositories.ts';
import {
  completeWorkItemWhenDelivered,
  getDelivery,
  updateDeliveryStatus,
  updateWorkItem,
} from '../../data/work.ts';
import { decideDelivery, type DeliveryVerdict } from '../../domain/delivery-lifecycle.ts';
import { repositoryPolicy } from '../../domain/repository-policy.ts';
import { mergeGithubChange } from '../../integrations/changes/github.ts';
import {
  readGithubDeliveryState,
  type GithubDeliveryState,
} from '../../integrations/changes/github-delivery.ts';
import { isJsonObject, isNumber } from '../../shared/json.ts';
import { syncGithubChangeRevision } from '../changes/github-revision.ts';
import { notifyOrganizationsLive } from '../notifications/live-updates.ts';
import { enqueueFactoryMessage } from './queue.ts';
import { executeReviewStage } from './stages/review.ts';
import { executeVerification } from './stages/verification.ts';
import { executeRepair } from './stages/repair.ts';

export interface DeliveryDependencies {
  readGithub: typeof readGithubDeliveryState;
  syncGithub: typeof syncGithubChangeRevision;
  enqueue: typeof enqueueFactoryMessage;
  notify: typeof notifyOrganizationsLive;
}
const defaults: DeliveryDependencies = {
  readGithub: readGithubDeliveryState,
  syncGithub: syncGithubChangeRevision,
  enqueue: enqueueFactoryMessage,
  notify: notifyOrganizationsLive,
};

function eligible(change: ChangeRow) {
  return (
    change.delivery_id !== null &&
    ['factory', 'automation'].includes(change.origin) &&
    change.source_ref.startsWith('turbodiff/')
  );
}
export function ciVerdict(
  state: GithubDeliveryState | null,
  revision: ChangeRevisionRow,
): DeliveryVerdict | 'pending' {
  if (!state) return 'passed';
  for (const check of state.checks) {
    if (check.status !== 'completed' || check.conclusion === null) return 'pending';
    if (!['success', 'neutral', 'skipped'].includes(check.conclusion)) return 'failed';
  }
  // Give GitHub time to discover workflow runs before considering a check-free repository ready.
  return Date.now() - new Date(revision.created_at).getTime() < 60_000 ? 'pending' : 'passed';
}

async function decisionFor(
  run: FactoryRunRow,
  revision: ChangeRevisionRow,
  repository: RepositoryRow,
  state: GithubDeliveryState | null,
) {
  const [stages, events] = await Promise.all([listStageRuns(run.id), listLifecycleEvents(run.id)]);
  const resumed = events.findLast((event) => event.kind === 'delivery_resumed')?.id ?? 0;
  const verdict = (operation: string): DeliveryVerdict | null => {
    const event = events.findLast(
      (event) =>
        event.id > resumed &&
        event.kind === 'delivery_stage_completed' &&
        isJsonObject(event.payload) &&
        event.payload.revisionId === revision.id &&
        stages.some((stage) => stage.id === event.stage_run_id && stage.stage_key === operation),
    );
    if (!event || !isJsonObject(event.payload)) return null;
    return event.payload.verdict === 'passed' ||
      event.payload.verdict === 'failed' ||
      event.payload.verdict === 'inconclusive'
      ? event.payload.verdict
      : null;
  };
  return decideDelivery({
    policy: repositoryPolicy(repository.settings),
    review: verdict('review'),
    verification: verdict('verify'),
    ci: ciVerdict(state, revision),
    repairAttempts: stages.filter((stage) => stage.stage_key === 'repair').length,
    repairUnchanged: events.some(
      (event) =>
        event.id > resumed &&
        event.kind === 'delivery_stage_completed' &&
        isJsonObject(event.payload) &&
        event.payload.revisionId === revision.id &&
        event.payload.verdict === 'unchanged',
    ),
  });
}

async function completeDelivery(change: ChangeRow) {
  if (!change.delivery_id) return;
  const delivery = await getDelivery(change.delivery_id);
  if (!delivery) return;
  await updateDeliveryStatus(delivery.id, 'completed');
  await completeWorkItemWhenDelivered(delivery.work_item_id);
}

/** Provider IO is outside the short database scheduling transaction. */
export async function reconcileChangeDelivery(
  changeId: number,
  overrides: Partial<DeliveryDependencies> = {},
): Promise<void> {
  const dependencies = { ...defaults, ...overrides };
  const change = await getChange(changeId);
  if (!change || !eligible(change)) return;
  const repository = await getRepository(change.repository_id);
  if (!repository?.enabled || !(await getIntegration(repository.source_integration_id))?.enabled)
    return;
  if (!repositoryPolicy(repository.settings).verify) return;
  let state: GithubDeliveryState | null = null;
  if (repository.source_provider === 'github') {
    state = await dependencies.readGithub(repository, change);
    if (state.status !== change.status) await updateChangeStatus(change.id, state.status);
    if (state.status === 'merged') {
      await completeDelivery(change);
      return;
    }
    if (state.status !== 'open') return;
    const current = await latestChangeRevision(change.id);
    if (current?.head_sha !== state.headSha)
      await dependencies.syncGithub(repository, change, state.headSha);
  } else if (change.status !== 'open') return;
  const revision = await latestChangeRevision(change.id);
  if (!revision) return;
  if (state) for (const check of state.checks) await recordChangeCheck(revision, check);
  const stage = await withDeliveryLock(change.id, async (freshChange) => {
    if (
      freshChange.status !== 'open' ||
      (await latestChangeRevision(change.id))?.id !== revision.id
    )
      return null;
    const freshRepo = await getRepository(repository.id);
    if (!freshRepo?.enabled) return null;
    const run = await deliveryRun(freshChange);
    if (run.status === 'failed' || run.status === 'cancelled') return null;
    if (
      (await listStageRuns(run.id)).some(
        (stage) => stage.status === 'queued' || stage.status === 'running',
      )
    )
      return null;
    let decision = await decisionFor(run, revision, freshRepo, state);
    if (state && (!state.writable || state.draft))
      decision = {
        kind: 'wait',
        reason: 'Pull request is draft or its source branch is not writable by this factory.',
      };
    if (
      state &&
      decision.kind === 'stage' &&
      decision.operation === 'merge' &&
      state.mergeable !== true
    )
      decision = {
        kind: 'wait',
        reason: 'Waiting for GitHub to report the pull request mergeable.',
      };
    if (state?.humanReviewBlocked && decision.kind === 'stage' && decision.operation === 'merge')
      decision = { kind: 'wait', reason: 'A human reviewer requested changes.' };
    const next = await applyDeliveryDecision(run, revision, decision);
    if (decision.kind === 'complete') await completeDelivery(freshChange);
    else if (freshChange.delivery_id) {
      await updateDeliveryStatus(freshChange.delivery_id, 'active');
      const delivery = await getDelivery(freshChange.delivery_id);
      if (delivery) await updateWorkItem(delivery.work_item_id, { status: 'in_progress' });
    }
    return next;
  });
  if (stage) {
    try {
      await dependencies.enqueue({
        kind: 'run_factory',
        factoryRunId: stage.factory_run_id,
        stageRunId: stage.id,
      });
    } catch (error) {
      console.warn('turbodiff: delivery enqueue deferred to recovery', error);
    }
  }
  await dependencies.notify([change.organization_id]);
}

export interface DeliveryStageDependencies extends DeliveryDependencies {
  review: typeof executeReviewStage;
  verify: typeof executeVerification;
  repair: typeof executeRepair;
  merge: typeof mergeGithubChange;
}

export async function executeChangeDeliveryStage(
  run: FactoryRunRow,
  stage: StageRunRow,
  overrides: Partial<DeliveryStageDependencies> = {},
): Promise<void> {
  const dependencies = {
    ...defaults,
    review: executeReviewStage,
    verify: executeVerification,
    repair: executeRepair,
    merge: mergeGithubChange,
    ...overrides,
  };
  const scheduled = (await listLifecycleEvents(run.id)).find(
    (event) => event.stage_run_id === stage.id && event.kind === 'delivery_stage_scheduled',
  );
  const revisionId =
    scheduled && isJsonObject(scheduled.payload) ? scheduled.payload.revisionId : null;
  const revision = isNumber(revisionId) ? await getChangeRevision(revisionId) : null;
  const change = run.change_id ? await getChange(run.change_id) : null;
  const repository = change ? await getRepository(change.repository_id) : null;
  if (
    !change ||
    !revision ||
    revision.change_id !== change.id ||
    !repository ||
    change.organization_id !== run.organization_id ||
    !eligible(change)
  )
    throw new Error('Invalid delivery stage scope');
  const finish = async (result: {
    revisionId: number;
    verdict: string;
    artifactId?: number;
    reason?: string;
  }) => {
    await completeDeliveryStage(run, stage, result);
    try {
      await reconcileChangeDelivery(change.id, dependencies);
    } catch (error) {
      console.warn('turbodiff: delivery continuation deferred to recovery', error);
    }
  };
  if (
    !repository.enabled ||
    !(await getIntegration(repository.source_integration_id))?.enabled ||
    !repositoryPolicy(repository.settings).verify ||
    change.status !== 'open'
  ) {
    await completeDeliveryStage(run, stage, {
      revisionId: revision.id,
      verdict: 'skipped',
      reason: 'Delivery is no longer enabled or open.',
    });
    return;
  }
  let state =
    repository.source_provider === 'github'
      ? await dependencies.readGithub(repository, change)
      : null;
  if (state && state.status !== 'open') {
    await updateChangeStatus(change.id, state.status);
    if (state.status === 'merged') await completeDelivery(change);
    await completeDeliveryStage(run, stage, {
      revisionId: revision.id,
      verdict: 'skipped',
      reason: 'Pull request is no longer open.',
    });
    await updateFactoryRunStatus(run.id, state.status === 'merged' ? 'succeeded' : 'cancelled');
    return;
  }
  if (
    (await latestChangeRevision(change.id))?.id !== revision.id ||
    (state && state.headSha !== revision.head_sha)
  ) {
    await finish({
      revisionId: revision.id,
      verdict: 'stale',
      reason: 'The commit changed; reevaluating the current revision.',
    });
    return;
  }
  if (state && (state.draft || !state.writable)) {
    await finish({ revisionId: revision.id, verdict: 'skipped' });
    return;
  }
  if (stage.stage_key === 'reconcile') {
    await finish({ revisionId: revision.id, verdict: 'resumed' });
  } else if (stage.stage_key === 'review') {
    const reviewed = await dependencies.review(run, stage, revision.id);
    const outcomes = (await listReviewOutcomes(revision.id)).filter((outcome) =>
      reviewed.agentRunIds.includes(outcome.agent_run_id),
    );
    const verdict = outcomes.some((item) => item.verdict === 'request_changes')
      ? 'failed'
      : outcomes.length === 0 ||
          outcomes.some(
            (item) => item.coverage_status !== 'complete' || item.conclusion === 'inconclusive',
          )
        ? 'inconclusive'
        : 'passed';
    await finish({ revisionId: revision.id, verdict });
  } else if (stage.stage_key === 'verify')
    await finish(await dependencies.verify(run, stage, repository, change, revision));
  else if (stage.stage_key === 'repair')
    await finish(await dependencies.repair(run, stage, repository, change, revision));
  else if (stage.stage_key === 'merge') {
    // Refresh every gate immediately before the provider mutation, not only when the stage was queued.
    const freshRepo = await getRepository(repository.id);
    state =
      repository.source_provider === 'github'
        ? await dependencies.readGithub(repository, change)
        : null;
    const decision = freshRepo ? await decisionFor(run, revision, freshRepo, state) : null;
    if (
      !freshRepo?.enabled ||
      !(await getIntegration(repository.source_integration_id))?.enabled ||
      state?.humanReviewBlocked ||
      !repositoryPolicy(freshRepo.settings).merge ||
      !state?.writable ||
      state.draft ||
      state.status !== 'open' ||
      state.headSha !== revision.head_sha ||
      state.mergeable !== true ||
      decision?.kind !== 'stage' ||
      decision.operation !== 'merge'
    ) {
      await finish({
        revisionId: revision.id,
        verdict: 'stale',
        reason: 'Merge gates changed; reevaluating.',
      });
      return;
    }
    await dependencies.merge(freshRepo, change, revision.head_sha);
    await updateChangeStatus(change.id, 'merged');
    await completeDelivery(change);
    await completeDeliveryStage(run, stage, { revisionId: revision.id, verdict: 'passed' });
    await updateFactoryRunStatus(run.id, 'succeeded');
    await dependencies.notify([run.organization_id]);
  } else throw new Error('Unknown delivery operation');
}
