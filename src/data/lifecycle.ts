import { sql } from 'drizzle-orm';
import type {
  LifecycleDecision,
  LifecycleEventKind,
  LifecycleStage,
  ProcessProfileKey,
  RunStatus,
} from '../domain/lifecycle-contract.ts';
import type { JsonValue } from '../shared/json.ts';
import { execute, queryOne, queryRows, withTransaction } from './database.ts';

export interface FactoryRunRow {
  id: number;
  repository_id: number;
  work_item_id: number | null;
  change_id: number | null;
  profile_key: ProcessProfileKey;
  start_stage: LifecycleStage;
  stop_after_stage: LifecycleStage;
  policy_snapshot: JsonValue;
  trigger: string;
  actor: string | null;
  status: RunStatus;
  handoff_reason: string | null;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface StageRunRow {
  id: number;
  factory_run_id: number;
  change_id: number | null;
  stage: LifecycleStage;
  attempt: number;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  trigger: string;
  input: JsonValue | null;
  output: JsonValue | null;
  workflow_instance: string | null;
  error: string | null;
  idempotency_key: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export async function createFactoryRunWithStage(input: {
  repositoryId: number;
  changeId: number | null;
  workItemId?: number | null;
  profileKey: ProcessProfileKey;
  startStage: LifecycleStage;
  stopAfterStage: LifecycleStage;
  policySnapshot: JsonValue;
  trigger: string;
  actor?: string | null;
  eventKind: LifecycleEventKind;
  eventPayload?: JsonValue;
  decision: LifecycleDecision;
  idempotencyKey: string;
}): Promise<{ run: FactoryRunRow; stageRun: StageRunRow | null }> {
  return withTransaction(async () => {
    const run = await queryOne<FactoryRunRow>(sql`
      INSERT INTO app.factory_runs (
        repository_id, work_item_id, change_id, profile_key, start_stage,
        stop_after_stage, policy_snapshot, trigger, actor, idempotency_key
      ) VALUES (
        ${input.repositoryId}, ${input.workItemId ?? null}, ${input.changeId},
        ${input.profileKey}, ${input.startStage}, ${input.stopAfterStage},
        ${JSON.stringify(input.policySnapshot)}::jsonb, ${input.trigger},
        ${input.actor ?? null}, ${input.idempotencyKey}
      )
      ON CONFLICT (idempotency_key) DO UPDATE SET
        idempotency_key = EXCLUDED.idempotency_key
      RETURNING *
    `);
    if (!run) throw new Error('factory run insert returned no row');

    await execute(sql`
      INSERT INTO app.lifecycle_events (
        idempotency_key, factory_run_id, change_id, kind, payload, decision
      ) VALUES (
        ${`event:${input.idempotencyKey}`}, ${run.id}, ${input.changeId}, ${input.eventKind},
        ${input.eventPayload === undefined ? null : JSON.stringify(input.eventPayload)}::jsonb,
        ${JSON.stringify(input.decision)}::jsonb
      )
      ON CONFLICT (idempotency_key) DO NOTHING
    `);

    if (input.decision.kind !== 'schedule') {
      await applyRunDecision(run.id, input.decision);
      return { run: (await getFactoryRun(run.id)) ?? run, stageRun: null };
    }

    const stageRun = await queryOne<StageRunRow>(sql`
      INSERT INTO app.stage_runs (
        factory_run_id, change_id, stage, trigger, idempotency_key
      ) VALUES (
        ${run.id}, ${input.changeId}, ${input.decision.stage}, ${input.trigger},
        ${`${run.id}:${input.decision.stage}:1`}
      )
      ON CONFLICT (idempotency_key) DO UPDATE SET
        idempotency_key = EXCLUDED.idempotency_key
      RETURNING *
    `);
    if (!stageRun) throw new Error('stage run insert returned no row');
    return { run, stageRun };
  });
}

export async function getFactoryRun(id: number): Promise<FactoryRunRow | null> {
  return queryOne<FactoryRunRow>(sql`SELECT * FROM app.factory_runs WHERE id = ${id}`);
}

export async function getStageRun(id: number): Promise<StageRunRow | null> {
  return queryOne<StageRunRow>(sql`SELECT * FROM app.stage_runs WHERE id = ${id}`);
}

export async function listStageRuns(factoryRunId: number): Promise<StageRunRow[]> {
  return queryRows<StageRunRow>(sql`
    SELECT * FROM app.stage_runs WHERE factory_run_id = ${factoryRunId} ORDER BY id
  `);
}

export async function claimStageRun(
  id: number,
  idempotencyKey: string,
): Promise<StageRunRow | null> {
  return queryOne<StageRunRow>(sql`
    UPDATE app.stage_runs SET status = 'running', started_at = CURRENT_TIMESTAMP
    WHERE id = ${id} AND idempotency_key = ${idempotencyKey} AND status = 'queued'
    RETURNING *
  `);
}

export async function finishStageRun(
  id: number,
  status: 'completed' | 'failed',
  output?: JsonValue,
  error?: string,
): Promise<void> {
  await execute(sql`
    UPDATE app.stage_runs SET status = ${status},
      output = ${output === undefined ? null : JSON.stringify(output)}::jsonb,
      error = ${error ?? null}, completed_at = CURRENT_TIMESTAMP
    WHERE id = ${id} AND status = 'running'
  `);
}

export async function recordStageRunOutput(id: number, output: JsonValue): Promise<void> {
  await execute(sql`
    UPDATE app.stage_runs SET output = ${JSON.stringify(output)}::jsonb
    WHERE id = ${id} AND status = 'running'
  `);
}

export async function recordLifecycleDecision(
  runId: number,
  changeId: number | null,
  eventKind: LifecycleEventKind,
  eventPayload: JsonValue,
  decision: LifecycleDecision,
  idempotencyKey: string,
): Promise<StageRunRow | null> {
  return withTransaction(async () => {
    const inserted = await execute(sql`
      INSERT INTO app.lifecycle_events (
        idempotency_key, factory_run_id, change_id, kind, payload, decision
      ) VALUES (
        ${idempotencyKey}, ${runId}, ${changeId}, ${eventKind},
        ${JSON.stringify(eventPayload)}::jsonb, ${JSON.stringify(decision)}::jsonb
      )
      ON CONFLICT (idempotency_key) DO NOTHING
    `);
    if (inserted === 0) return null;

    if (decision.kind !== 'schedule') {
      await applyRunDecision(runId, decision);
      return null;
    }
    const attemptRow = await queryOne<{ attempt: number }>(sql`
      SELECT COALESCE(MAX(attempt), 0) + 1 AS attempt
      FROM app.stage_runs WHERE factory_run_id = ${runId} AND stage = ${decision.stage}
    `);
    const attempt = attemptRow?.attempt ?? 1;
    const stageRun = await queryOne<StageRunRow>(sql`
      INSERT INTO app.stage_runs (
        factory_run_id, change_id, stage, attempt, trigger, idempotency_key
      ) VALUES (
        ${runId}, ${changeId}, ${decision.stage}, ${attempt}, ${eventKind},
        ${`${runId}:${decision.stage}:${attempt}`}
      )
      RETURNING *
    `);
    if (!stageRun) throw new Error('stage run insert returned no row');
    return stageRun;
  });
}

async function applyRunDecision(runId: number, decision: LifecycleDecision): Promise<void> {
  if (decision.kind === 'schedule' || decision.kind === 'ignore') return;
  const status: RunStatus =
    decision.kind === 'wait'
      ? 'awaiting_human'
      : decision.kind === 'handoff'
        ? 'handed_off'
        : 'completed';
  const reason = decision.kind === 'wait' || decision.kind === 'handoff' ? decision.reason : null;
  await execute(sql`
    UPDATE app.factory_runs SET status = ${status}, handoff_reason = ${reason},
      updated_at = CURRENT_TIMESTAMP,
      completed_at = CASE WHEN ${status} IN ('handed_off', 'completed')
        THEN CURRENT_TIMESTAMP ELSE completed_at END
    WHERE id = ${runId}
  `);
}
