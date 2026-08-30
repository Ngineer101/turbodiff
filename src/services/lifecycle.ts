import {
  attachFactoryRunChange,
  claimStageRun,
  completeReview,
  createAcceptanceContract,
  createFactoryRunWithStage,
  finishStageRun,
  getChange,
  getChangeRequestByChangeId,
  getFeature,
  getFactoryRun,
  getRepoById,
  getStageRun,
  latestAcceptanceContractForChange,
  listCrChecks,
  listStageRuns,
  markReviewFailed,
  recordLifecycleDecision,
  recordStageRunOutput,
  reviewStageProgress,
} from '../data/db.ts';
import { decideLifecycle, type LifecycleContext } from '../domain/lifecycle-coordinator.ts';
import { isDeliveryProcessProfile, processProfile } from '../domain/process-profiles.ts';
import type {
  LifecycleDecision,
  LifecycleEventKind,
  RunStageCommand,
} from '../domain/lifecycle-contract.ts';
import { isJsonObject, isNumber, parseJson, type JsonValue } from '../shared/json.ts';
import type { GenerateQueueMessage, VerifyQueueMessage } from '../shared/factory-messages.ts';
import { installationToken } from '../integrations/github/app.ts';
import { githubJson, githubPaginate } from '../integrations/github/client.ts';
import { dispatchChangeReviews, type ReviewDispatcher } from './change-review.ts';
import { mergePullRequest } from './auto-merge.ts';
import { enqueueFactoryMessage } from './factory-queue.ts';
import { checkMergeability } from './merge-conflicts.ts';
import { computeRiskTier } from './review-policy.ts';

export type NativeReviewDispatcher = (
  changeRequestId: number,
  stageRunId?: number,
) => Promise<boolean>;

function reviewContext(
  event: LifecycleEventKind,
  origin: LifecycleContext['origin'],
  capabilities: LifecycleContext['capabilities'],
  facts: LifecycleContext['facts'],
): LifecycleContext {
  return {
    event,
    origin,
    startStage: 'review',
    stopAfterStage: 'review',
    capabilities,
    facts,
  };
}

function commandFor(
  factoryRunId: number,
  stageRunId: number,
  stage: RunStageCommand['stage'],
  changeId?: number | null,
  idempotencyKey = `${factoryRunId}:${stage}:1`,
): RunStageCommand {
  const command: RunStageCommand = {
    kind: 'run_stage',
    factoryRunId,
    stageRunId,
    stage,
    idempotencyKey,
  };
  if (changeId != null) command.changeId = changeId;
  return command;
}

export async function scheduleChangeReview(input: {
  changeId: number;
  trigger: 'opened' | 'ready_for_review' | 'synchronize' | 'manual';
  actor?: string | null;
  idempotencyKey: string;
  enqueue?: typeof enqueueFactoryMessage;
}): Promise<{ runId: number; stageRunId: number | null; decision: LifecycleDecision }> {
  const change = await getChange(input.changeId);
  if (!change) throw new Error(`change ${input.changeId} not found`);
  const repo = await getRepoById(change.repository_id);
  if (!repo) throw new Error(`repository ${change.repository_id} not found`);

  const event: LifecycleEventKind =
    input.trigger === 'manual'
      ? 'human.resume_requested'
      : input.trigger === 'synchronize'
        ? 'change.updated'
        : 'change.opened';
  const context = reviewContext(event, change.origin, change.capabilities, {
    draft: change.draft,
    repositoryEnabled: repo.enabled,
    headChanged: input.trigger === 'synchronize',
    debounceActive: false,
    intakeMatches: true,
  });
  const decision = decideLifecycle(repo.process_profile, context);
  const profile = processProfile(repo.process_profile);
  const stopAfterStage = repo.process_profile === 'review_and_repair' ? 'merge' : 'review';
  const created = await createFactoryRunWithStage({
    repositoryId: repo.id,
    changeId: change.id,
    profileKey: repo.process_profile,
    startStage: 'review',
    stopAfterStage,
    policySnapshot: parseJson(JSON.stringify(profile)),
    trigger: input.trigger,
    actor: input.actor,
    eventKind: event,
    eventPayload: { trigger: input.trigger },
    decision,
    idempotencyKey: input.idempotencyKey,
  });

  if (created.stageRun) {
    const enqueue = input.enqueue ?? enqueueFactoryMessage;
    await enqueue(commandFor(created.run.id, created.stageRun.id, 'review', change.id));
  }
  return {
    runId: created.run.id,
    stageRunId: created.stageRun?.id ?? null,
    decision,
  };
}

export async function scheduleFeatureDelivery(
  featureId: number,
  enqueue: typeof enqueueFactoryMessage = enqueueFactoryMessage,
): Promise<boolean> {
  const feature = await getFeature(featureId);
  if (!feature) throw new Error(`feature ${featureId} not found`);
  const repo = await getRepoById(feature.repository_id);
  if (!repo) throw new Error(`repository ${feature.repository_id} not found`);
  if (!isDeliveryProcessProfile(repo.process_profile)) return false;

  const stopAfterStage =
    repo.process_profile === 'idea_to_pr'
      ? 'publish'
      : repo.process_profile === 'assisted_delivery'
        ? 'verify'
        : 'merge';
  const decision = decideLifecycle(repo.process_profile, {
    event: 'work.requested',
    origin: 'factory',
    startStage: 'implement',
    stopAfterStage,
    facts: { repositoryEnabled: repo.enabled },
  });
  const created = await createFactoryRunWithStage({
    repositoryId: repo.id,
    changeId: null,
    profileKey: repo.process_profile,
    startStage: 'implement',
    stopAfterStage,
    policySnapshot: parseJson(JSON.stringify(processProfile(repo.process_profile))),
    trigger: 'feature_approved',
    actor: feature.author_login,
    eventKind: 'work.requested',
    eventPayload: { featureId },
    decision,
    idempotencyKey: `feature-delivery:${featureId}`,
    stageInput: { featureId },
    workItem: {
      origin: 'idea',
      title: feature.title,
      description: feature.spec,
    },
  });
  if (created.stageRun) {
    await enqueue(commandFor(created.run.id, created.stageRun.id, created.stageRun.stage, null));
  }
  return true;
}

function stageResultOutput(result: Awaited<ReturnType<typeof dispatchChangeReviews>>): JsonValue {
  if (result.kind === 'dispatched') {
    return { kind: result.kind, tier: result.tier, agents: result.agents };
  }
  return { kind: result.kind, reason: result.reason };
}

function featureIdFromInput(input: JsonValue | null): number | null {
  if (!isJsonObject(input)) return null;
  const featureId = input.featureId;
  return isNumber(featureId) && Number.isSafeInteger(featureId) ? featureId : null;
}

async function assertGithubMergeReady(
  token: string,
  repo: { owner: string; name: string },
  change: { number: number; source_head: string | null },
): Promise<void> {
  if (!change.source_head) throw new Error('change head is unknown');
  const mergeability = await checkMergeability(token, repo.owner, repo.name, change.number, {
    retryOnUnknown: true,
  });
  if (mergeability.mergeable !== true || mergeability.mergeableState !== 'clean') {
    throw new Error(`change is not merge-ready (${mergeability.mergeableState})`);
  }

  type CheckRun = { status: string; conclusion: string | null };
  const checkRuns = await githubPaginate<{ check_runs: CheckRun[] }, CheckRun>(
    token,
    `/repos/${repo.owner}/${repo.name}/commits/${change.source_head}/check-runs?per_page=100`,
    (page) => page.check_runs,
    { maxPages: Infinity },
  );
  const acceptableConclusions = new Set(['success', 'neutral', 'skipped']);
  if (
    checkRuns.some(
      (check) =>
        check.status !== 'completed' ||
        !check.conclusion ||
        !acceptableConclusions.has(check.conclusion),
    )
  ) {
    throw new Error('external check runs are not green');
  }
  const status = await githubJson<{ state: string; total_count: number }>(
    token,
    `/repos/${repo.owner}/${repo.name}/commits/${change.source_head}/status`,
  );
  if (status.total_count > 0 && status.state !== 'success') {
    throw new Error(`external commit statuses are ${status.state}`);
  }
}

async function coordinateStageOutcome(
  command: RunStageCommand,
  success: boolean,
  enqueue: typeof enqueueFactoryMessage,
  outcomeFacts: LifecycleContext['facts'] = {},
): Promise<void> {
  const run = await getFactoryRun(command.factoryRunId);
  const stageRun = await getStageRun(command.stageRunId);
  const changeId = command.changeId ?? run?.change_id ?? null;
  const change = changeId ? await getChange(changeId) : null;
  const repo = run ? await getRepoById(run.repository_id) : null;
  if (!run || !repo) return;
  const featureId = featureIdFromInput(stageRun?.input ?? null);
  const feature = featureId ? await getFeature(featureId) : null;
  const acceptanceContract = change ? await latestAcceptanceContractForChange(change.id) : null;

  const completed = (await listStageRuns(run.id))
    .filter((stageRun) => stageRun.status === 'completed')
    .map((stageRun) => stageRun.stage);
  const event: LifecycleEventKind = success ? 'stage.completed' : 'stage.failed';
  const context: LifecycleContext = {
    event,
    origin: change?.origin ?? 'imported',
    startStage: run.start_stage,
    stopAfterStage: run.stop_after_stage,
    completedStages: completed,
    capabilities: change?.capabilities,
    facts: {
      repositoryEnabled: repo.enabled,
      acceptanceContractPresent: acceptanceContract !== null || feature?.acceptance != null,
      criteriaConflict: feature?.criteria_conflict === true,
      ...outcomeFacts,
    },
  };
  const decision = decideLifecycle(run.profile_key, context);
  const next = await recordLifecycleDecision(
    run.id,
    change?.id ?? null,
    event,
    { stageRunId: command.stageRunId, success },
    decision,
    `${command.idempotencyKey}:${event}`,
    stageRun?.input ?? undefined,
  );
  if (next) {
    await enqueue(
      commandFor(
        run.id,
        next.id,
        next.stage,
        next.change_id ?? change?.id ?? null,
        next.idempotency_key,
      ),
    );
  }
}

async function settleReviewStage(
  stageRunId: number,
  enqueue: typeof enqueueFactoryMessage,
): Promise<void> {
  const stageRun = await getStageRun(stageRunId);
  if (!stageRun || stageRun.stage !== 'review' || stageRun.status !== 'running') return;
  const progress = await reviewStageProgress(stageRunId);
  if (progress.running > 0) return;
  const output: JsonValue = {
    running: progress.running,
    completed: progress.completed,
    failed: progress.failed,
    blocking: progress.blocking,
  };
  const command: RunStageCommand = {
    kind: 'run_stage',
    factoryRunId: stageRun.factory_run_id,
    stageRunId: stageRun.id,
    stage: 'review',
    idempotencyKey: stageRun.idempotency_key,
  };
  if (stageRun.change_id !== null) command.changeId = stageRun.change_id;
  if (progress.completed === 0) {
    await finishStageRun(stageRun.id, 'failed', output, 'all review dispatches failed');
    await coordinateStageOutcome(command, false, enqueue);
    return;
  }
  await finishStageRun(stageRun.id, 'completed', output);
  await coordinateStageOutcome(command, true, enqueue, {
    blockingFindings: progress.blocking,
  });
}

export async function completeLifecycleReview(
  agentInstanceId: string,
  reviewUrl: string | null,
  findingsCount: number,
  verdict: 'approve' | 'comment' | 'request_changes',
  enqueue: typeof enqueueFactoryMessage = enqueueFactoryMessage,
): Promise<void> {
  const completed = await completeReview(agentInstanceId, reviewUrl, findingsCount, verdict);
  if (completed?.stage_run_id) await settleReviewStage(completed.stage_run_id, enqueue);
}

export async function failLifecycleReview(
  agentInstanceId: string,
  enqueue: typeof enqueueFactoryMessage = enqueueFactoryMessage,
): Promise<void> {
  const failed = await markReviewFailed(agentInstanceId);
  if (failed?.stage_run_id) await settleReviewStage(failed.stage_run_id, enqueue);
}

export async function completeLifecycleRepair(
  stageRunId: number,
  success: boolean,
  output: JsonValue,
  enqueue: typeof enqueueFactoryMessage = enqueueFactoryMessage,
): Promise<void> {
  await completeLifecycleStage(stageRunId, 'repair', success, output, {}, enqueue);
}

export async function completeLifecycleStage(
  stageRunId: number,
  expectedStage: RunStageCommand['stage'],
  success: boolean,
  output: JsonValue,
  outcomeFacts: LifecycleContext['facts'] = {},
  enqueue: typeof enqueueFactoryMessage = enqueueFactoryMessage,
): Promise<void> {
  const stageRun = await getStageRun(stageRunId);
  if (!stageRun || stageRun.stage !== expectedStage || stageRun.status !== 'running') return;
  const command: RunStageCommand = {
    kind: 'run_stage',
    factoryRunId: stageRun.factory_run_id,
    stageRunId: stageRun.id,
    stage: stageRun.stage,
    idempotencyKey: stageRun.idempotency_key,
  };
  if (stageRun.change_id !== null) command.changeId = stageRun.change_id;
  await finishStageRun(
    stageRun.id,
    success ? 'completed' : 'failed',
    output,
    success ? undefined : `${stageRun.stage} stage failed`,
  );
  await coordinateStageOutcome(command, success, enqueue, outcomeFacts);
}

export async function runLifecycleStage(
  command: RunStageCommand,
  dispatchReview: ReviewDispatcher,
  dependencies: {
    enqueue?: typeof enqueueFactoryMessage;
    computeRisk?: typeof computeRiskTier;
    dispatchNativeReview?: NativeReviewDispatcher;
    mergeGithub?: (repoId: number, changeNumber: number) => Promise<void>;
    mergeNative?: (changeRequestId: number, actor: string) => Promise<void>;
  } = {},
): Promise<void> {
  const stageRun = await claimStageRun(command.stageRunId, command.idempotencyKey);
  if (!stageRun) return;
  const enqueue = dependencies.enqueue ?? enqueueFactoryMessage;

  if (stageRun.stage !== command.stage || stageRun.factory_run_id !== command.factoryRunId) {
    await finishStageRun(stageRun.id, 'failed', undefined, 'stage command does not match claim');
    await coordinateStageOutcome(command, false, enqueue);
    return;
  }
  const run = await getFactoryRun(stageRun.factory_run_id);
  const change = stageRun.change_id ? await getChange(stageRun.change_id) : null;
  const repo = run ? await getRepoById(run.repository_id) : null;
  const featureId = featureIdFromInput(stageRun.input);
  const feature = featureId ? await getFeature(featureId) : null;
  if (!run || !repo) {
    await finishStageRun(stageRun.id, 'failed', undefined, 'stage inputs are unavailable');
    await coordinateStageOutcome(command, false, enqueue);
    return;
  }
  if (stageRun.stage === 'implement') {
    if (!feature) {
      await finishStageRun(stageRun.id, 'failed', undefined, 'feature input is unavailable');
      await coordinateStageOutcome(command, false, enqueue);
      return;
    }
    const message: GenerateQueueMessage = {
      kind: 'generate',
      featureId: feature.id,
      factoryRunId: run.id,
      stageRunId: stageRun.id,
    };
    await enqueue(message);
    await recordStageRunOutput(stageRun.id, { kind: 'generation_enqueued', featureId: feature.id });
    return;
  }
  if (stageRun.stage === 'publish') {
    if (!feature?.change_id) {
      await finishStageRun(stageRun.id, 'failed', undefined, 'generation did not publish a change');
      await coordinateStageOutcome(command, false, enqueue);
      return;
    }
    await attachFactoryRunChange(run.id, feature.change_id);
    if (feature.acceptance) {
      await createAcceptanceContract({
        workItemId: run.work_item_id,
        changeId: feature.change_id,
        criteria: feature.acceptance,
        source: 'feature.acceptance',
      });
    }
    await completeLifecycleStage(
      stageRun.id,
      'publish',
      true,
      { kind: 'change_published', changeId: feature.change_id, featureId: feature.id },
      {},
      enqueue,
    );
    return;
  }
  if (!change) {
    await finishStageRun(stageRun.id, 'failed', undefined, 'change input is unavailable');
    await coordinateStageOutcome(command, false, enqueue);
    return;
  }
  if (stageRun.stage === 'repair') {
    await enqueue({
      kind: 'fix',
      repoId: repo.id,
      prNumber: change.number,
      trigger: 'lifecycle_repair',
      factoryRunId: run.id,
      stageRunId: stageRun.id,
      changeId: change.id,
    });
    await recordStageRunOutput(stageRun.id, { kind: 'repair_enqueued' });
    return;
  }
  if (stageRun.stage === 'verify') {
    if (!feature) {
      await finishStageRun(stageRun.id, 'failed', undefined, 'verification feature unavailable');
      await coordinateStageOutcome(command, false, enqueue);
      return;
    }
    const message: VerifyQueueMessage = {
      kind: 'verify',
      featureId: feature.id,
      factoryRunId: run.id,
      stageRunId: stageRun.id,
    };
    await enqueue(message);
    await recordStageRunOutput(stageRun.id, {
      kind: 'verification_enqueued',
      featureId: feature.id,
    });
    return;
  }
  if (stageRun.stage === 'merge') {
    try {
      if (repo.provider === 'artifacts') {
        const cr = await getChangeRequestByChangeId(change.id);
        if (!cr || !dependencies.mergeNative) throw new Error('native merge executor unavailable');
        if (cr.mergeable !== true) throw new Error('native change is not mergeable');
        const checks = await listCrChecks(cr.id);
        if (checks.some((check) => check.status !== 'passed')) {
          throw new Error('native change checks are not green');
        }
        await dependencies.mergeNative(cr.id, run.actor ?? 'lifecycle');
      } else {
        if (dependencies.mergeGithub) {
          await dependencies.mergeGithub(repo.id, change.number);
        } else {
          const token = await installationToken(repo.installation_id);
          await assertGithubMergeReady(token, repo, change);
          await mergePullRequest(token, repo.owner, repo.name, change.number);
        }
      }
      await completeLifecycleStage(
        stageRun.id,
        'merge',
        true,
        { kind: 'change_merged', changeId: change.id },
        {},
        enqueue,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await finishStageRun(stageRun.id, 'failed', undefined, detail);
      await coordinateStageOutcome(command, false, enqueue);
    }
    return;
  }
  if (stageRun.stage !== 'review') {
    await finishStageRun(stageRun.id, 'failed', undefined, 'stage executor is not migrated yet');
    await coordinateStageOutcome(command, false, enqueue);
    return;
  }

  try {
    if (repo.provider === 'artifacts') {
      const cr = await getChangeRequestByChangeId(change.id);
      if (!cr || !dependencies.dispatchNativeReview) {
        await finishStageRun(
          stageRun.id,
          'failed',
          undefined,
          'native review dispatcher unavailable',
        );
        await coordinateStageOutcome(command, false, enqueue);
        return;
      }
      const dispatched = await dependencies.dispatchNativeReview(cr.id, stageRun.id);
      if (!dispatched) {
        await finishStageRun(stageRun.id, 'failed', undefined, 'native review dispatch failed');
        await coordinateStageOutcome(command, false, enqueue);
        return;
      }
      await recordStageRunOutput(stageRun.id, {
        kind: 'dispatched',
        provider: 'artifacts',
      });
      return;
    }

    const result = await dispatchChangeReviews(
      change,
      repo,
      run.trigger,
      dispatchReview,
      dependencies.computeRisk ?? computeRiskTier,
      run.trigger === 'synchronize',
      stageRun.id,
    );
    const success = result.kind === 'dispatched';
    if (success) {
      await recordStageRunOutput(stageRun.id, stageResultOutput(result));
    } else {
      await finishStageRun(stageRun.id, 'failed', stageResultOutput(result), result.reason);
      await coordinateStageOutcome(command, false, enqueue);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(
      JSON.stringify({
        event: 'lifecycle_stage_failed',
        factory_run_id: run.id,
        stage_run_id: stageRun.id,
        stage: stageRun.stage,
        error: detail,
      }),
    );
    await finishStageRun(stageRun.id, 'failed', undefined, detail);
    await coordinateStageOutcome(command, false, enqueue);
  }
}
