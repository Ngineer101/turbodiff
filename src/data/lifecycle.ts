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

export interface AcceptanceContractRow {
  id: number;
  work_item_id: number | null;
  change_id: number | null;
  version: number;
  criteria: JsonValue;
  source: string;
  created_at: string;
}

export interface LifecycleEventRow {
  idempotency_key: string;
  factory_run_id: number | null;
  change_id: number | null;
  kind: LifecycleEventKind;
  payload: JsonValue | null;
  decision: LifecycleDecision | null;
  created_at: string;
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
  stageInput?: JsonValue;
  workItem?: {
    origin: 'idea' | 'issue' | 'external_change' | 'automation' | 'api';
    title: string;
    description: string;
  };
}): Promise<{ run: FactoryRunRow; stageRun: StageRunRow | null }> {
  return withTransaction(async () => {
    let run = await queryOne<FactoryRunRow>(sql`
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

    if (input.workItem && run.work_item_id === null) {
      // Serialize duplicate deliveries on the idempotent run before creating
      // its work item, otherwise two concurrent transactions could leave an
      // orphaned duplicate work item behind.
      run =
        (await queryOne<FactoryRunRow>(sql`
          SELECT * FROM app.factory_runs WHERE id = ${run.id} FOR UPDATE
        `)) ?? run;
      if (run.work_item_id === null) {
        const workItem = await queryOne<{ id: number }>(sql`
          INSERT INTO app.work_items (repository_id, origin, title, description)
          VALUES (
            ${input.repositoryId}, ${input.workItem.origin}, ${input.workItem.title},
            ${input.workItem.description}
          )
          RETURNING id
        `);
        if (!workItem) throw new Error('work item insert returned no row');
        run =
          (await queryOne<FactoryRunRow>(sql`
            UPDATE app.factory_runs SET work_item_id = ${workItem.id}
            WHERE id = ${run.id}
            RETURNING *
          `)) ?? run;
      }
    }

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
        factory_run_id, change_id, stage, trigger, input, idempotency_key
      ) VALUES (
        ${run.id}, ${input.changeId}, ${input.decision.stage}, ${input.trigger},
        ${input.stageInput === undefined ? null : JSON.stringify(input.stageInput)}::jsonb,
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

export async function listFactoryRunsForFeature(featureId: number): Promise<FactoryRunRow[]> {
  return queryRows<FactoryRunRow>(sql`
    SELECT DISTINCT fr.*
    FROM app.factory_runs fr
    JOIN app.lifecycle_events le ON le.factory_run_id = fr.id
    WHERE le.payload ->> 'featureId' = ${String(featureId)}
    ORDER BY fr.created_at, fr.id
  `);
}

export async function listLifecycleEvents(factoryRunId: number): Promise<LifecycleEventRow[]> {
  return queryRows<LifecycleEventRow>(sql`
    SELECT * FROM app.lifecycle_events
    WHERE factory_run_id = ${factoryRunId}
    ORDER BY created_at, idempotency_key
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

// A claimed stage whose work was overtaken before it ran (a push review
// superseded by a newer push). Distinct from 'failed': nothing went wrong and
// nothing is left to retry.
export async function cancelStageRun(
  id: number,
  output: JsonValue | undefined,
  reason: string,
): Promise<void> {
  await execute(sql`
    UPDATE app.stage_runs SET status = 'cancelled',
      output = ${output === undefined ? null : JSON.stringify(output)}::jsonb,
      error = ${reason}, completed_at = CURRENT_TIMESTAMP
    WHERE id = ${id} AND status = 'running'
  `);
}

// Ends a run whose remaining work is moot, recording why as a lifecycle
// event so the cancellation is auditable and idempotent on its key. Terminal
// runs are left alone; the coordinator already treats 'cancelled' as final.
export async function cancelFactoryRun(
  runId: number,
  reason: string,
  idempotencyKey: string,
): Promise<void> {
  await withTransaction(async () => {
    await execute(sql`
      INSERT INTO app.lifecycle_events (
        idempotency_key, factory_run_id, change_id, kind, payload, decision
      )
      SELECT ${idempotencyKey}, id, change_id, 'run.cancelled',
        ${JSON.stringify({ reason })}::jsonb,
        ${JSON.stringify({ kind: 'ignore', reason })}::jsonb
      FROM app.factory_runs WHERE id = ${runId}
      ON CONFLICT (idempotency_key) DO NOTHING
    `);
    await execute(sql`
      UPDATE app.factory_runs SET status = 'cancelled', handoff_reason = ${reason},
        updated_at = CURRENT_TIMESTAMP, completed_at = CURRENT_TIMESTAMP
      WHERE id = ${runId} AND status IN ('active', 'awaiting_human')
    `);
  });
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
  stageInput?: JsonValue,
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
        factory_run_id, change_id, stage, attempt, trigger, input, idempotency_key
      ) VALUES (
        ${runId}, ${changeId}, ${decision.stage}, ${attempt}, ${eventKind},
        ${stageInput === undefined ? null : JSON.stringify(stageInput)}::jsonb,
        ${`${runId}:${decision.stage}:${attempt}`}
      )
      RETURNING *
    `);
    if (!stageRun) throw new Error('stage run insert returned no row');
    return stageRun;
  });
}

// A run parked by a stage failure ('awaiting_human') is active again once a
// retry schedules the next attempt; terminal runs are left alone.
export async function resumeFactoryRun(runId: number): Promise<void> {
  await execute(sql`
    UPDATE app.factory_runs SET status = 'active', handoff_reason = NULL,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${runId} AND status = 'awaiting_human'
  `);
}

export async function attachFactoryRunChange(runId: number, changeId: number): Promise<void> {
  await withTransaction(async () => {
    await execute(sql`
      UPDATE app.factory_runs SET change_id = ${changeId}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ${runId} AND (change_id IS NULL OR change_id = ${changeId})
    `);
    await execute(sql`
      UPDATE app.stage_runs SET change_id = ${changeId}
      WHERE factory_run_id = ${runId} AND change_id IS NULL
    `);
  });
}

export async function createAcceptanceContract(input: {
  workItemId?: number | null;
  changeId?: number | null;
  criteria: JsonValue;
  source: string;
}): Promise<AcceptanceContractRow> {
  if (input.workItemId == null && input.changeId == null) {
    throw new Error('acceptance contract requires a work item or change');
  }
  return withTransaction(async () => {
    const owner = input.changeId
      ? sql`change_id = ${input.changeId}`
      : sql`work_item_id = ${input.workItemId ?? null}`;
    const latest = await queryOne<{ version: number }>(sql`
      SELECT version FROM app.acceptance_contracts
      WHERE ${owner}
      ORDER BY version DESC
      LIMIT 1
      FOR UPDATE
    `);
    const version = (latest?.version ?? 0) + 1;
    const contract = await queryOne<AcceptanceContractRow>(sql`
      INSERT INTO app.acceptance_contracts (
        work_item_id, change_id, version, criteria, source
      ) VALUES (
        ${input.workItemId ?? null}, ${input.changeId ?? null}, ${version},
        ${JSON.stringify(input.criteria)}::jsonb, ${input.source}
      )
      RETURNING *
    `);
    if (!contract) throw new Error('acceptance contract insert returned no row');
    return contract;
  });
}

export async function latestAcceptanceContractForChange(
  changeId: number,
): Promise<AcceptanceContractRow | null> {
  return queryOne<AcceptanceContractRow>(sql`
    SELECT * FROM app.acceptance_contracts
    WHERE change_id = ${changeId}
    ORDER BY version DESC
    LIMIT 1
  `);
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
