import {
  claimStageRun,
  createFactoryRunWithStage,
  finishStageRun,
  getChange,
  getChangeRequestByChangeId,
  getFactoryRun,
  getRepoById,
  listStageRuns,
  recordLifecycleDecision,
} from '../data/db.ts';
import { decideLifecycle, type LifecycleContext } from '../domain/lifecycle-coordinator.ts';
import { processProfile } from '../domain/process-profiles.ts';
import type {
  LifecycleDecision,
  LifecycleEventKind,
  RunStageCommand,
} from '../domain/lifecycle-contract.ts';
import { parseJson, type JsonValue } from '../shared/json.ts';
import { dispatchChangeReviews, type ReviewDispatcher } from './change-review.ts';
import { enqueueFactoryMessage } from './factory-queue.ts';
import { computeRiskTier } from './review-policy.ts';

export type NativeReviewDispatcher = (changeRequestId: number) => Promise<boolean>;

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

function commandFor(factoryRunId: number, stageRunId: number, changeId: number): RunStageCommand {
  return {
    kind: 'run_stage',
    factoryRunId,
    stageRunId,
    stage: 'review',
    changeId,
    idempotencyKey: `${factoryRunId}:review:1`,
  };
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
  const created = await createFactoryRunWithStage({
    repositoryId: repo.id,
    changeId: change.id,
    profileKey: repo.process_profile,
    startStage: 'review',
    stopAfterStage: 'review',
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
    await enqueue(commandFor(created.run.id, created.stageRun.id, change.id));
  }
  return {
    runId: created.run.id,
    stageRunId: created.stageRun?.id ?? null,
    decision,
  };
}

function stageResultOutput(result: Awaited<ReturnType<typeof dispatchChangeReviews>>): JsonValue {
  if (result.kind === 'dispatched') {
    return { kind: result.kind, tier: result.tier, agents: result.agents };
  }
  return { kind: result.kind, reason: result.reason };
}

async function coordinateStageOutcome(
  command: RunStageCommand,
  success: boolean,
  enqueue: typeof enqueueFactoryMessage,
): Promise<void> {
  const run = await getFactoryRun(command.factoryRunId);
  const change = command.changeId ? await getChange(command.changeId) : null;
  const repo = run ? await getRepoById(run.repository_id) : null;
  if (!run || !repo) return;

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
    facts: { repositoryEnabled: repo.enabled },
  };
  const decision = decideLifecycle(run.profile_key, context);
  const next = await recordLifecycleDecision(
    run.id,
    change?.id ?? null,
    event,
    { stageRunId: command.stageRunId, success },
    decision,
    `${command.idempotencyKey}:${event}`,
  );
  if (next && change) {
    await enqueue({
      kind: 'run_stage',
      factoryRunId: run.id,
      stageRunId: next.id,
      stage: next.stage,
      changeId: change.id,
      idempotencyKey: next.idempotency_key,
    });
  }
}

export async function runLifecycleStage(
  command: RunStageCommand,
  dispatchReview: ReviewDispatcher,
  dependencies: {
    enqueue?: typeof enqueueFactoryMessage;
    computeRisk?: typeof computeRiskTier;
    dispatchNativeReview?: NativeReviewDispatcher;
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
  if (!run || !change || !repo) {
    await finishStageRun(stageRun.id, 'failed', undefined, 'stage inputs are unavailable');
    await coordinateStageOutcome(command, false, enqueue);
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
      const dispatched = await dependencies.dispatchNativeReview(cr.id);
      if (!dispatched) {
        await finishStageRun(stageRun.id, 'failed', undefined, 'native review dispatch failed');
        await coordinateStageOutcome(command, false, enqueue);
        return;
      }
      await finishStageRun(stageRun.id, 'completed', {
        kind: 'dispatched',
        provider: 'artifacts',
      });
      await coordinateStageOutcome(command, true, enqueue);
      return;
    }

    const result = await dispatchChangeReviews(
      change,
      repo,
      run.trigger,
      dispatchReview,
      dependencies.computeRisk ?? computeRiskTier,
      run.trigger === 'synchronize',
    );
    const success = result.kind === 'dispatched';
    await finishStageRun(
      stageRun.id,
      success ? 'completed' : 'failed',
      stageResultOutput(result),
      success ? undefined : result.reason,
    );
    await coordinateStageOutcome(command, success, enqueue);
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
