import { sql } from 'drizzle-orm';
import { execute, queryOne, queryRows, sqlValueList, withTransaction } from './postgres.ts';

export type FactoryRunStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type StageRunStatus = FactoryRunStatus | 'skipped';
export type AgentRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface FactoryRunRow {
  id: number;
  organization_id: string;
  flow_key: string;
  flow_version: number;
  model_id: number | null;
  work_item_id: number | null;
  delivery_id: number | null;
  change_id: number | null;
  automation_id: number | null;
  parent_run_id: number | null;
  trigger: string;
  actor_user_id: string | null;
  status: FactoryRunStatus;
  idempotency_key: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface StageRunRow {
  id: number;
  organization_id: string;
  factory_run_id: number;
  stage_key: string;
  attempt: number;
  status: StageRunStatus;
  idempotency_key: string;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface AgentRunRow {
  id: number;
  organization_id: string;
  stage_run_id: number;
  agent_id: number;
  model_id: number;
  input_artifact_id: number;
  output_artifact_id: number | null;
  log_artifact_id: number | null;
  status: AgentRunStatus;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  error_code: string | null;
  error_message: string | null;
  idempotency_key: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface LifecycleEventRow {
  id: number;
  organization_id: string;
  factory_run_id: number;
  stage_run_id: number | null;
  kind: string;
  payload: unknown;
  created_at: string;
}

export interface QueuedFactoryStageRow {
  factory_run_id: number;
  stage_run_id: number;
}

export async function createFactoryRun(input: {
  organizationId: string;
  flowKey: string;
  flowVersion: number;
  modelId?: number;
  workItemId?: number;
  deliveryId?: number;
  changeId?: number;
  automationId?: number;
  parentRunId?: number;
  trigger: string;
  actorUserId?: string;
  idempotencyKey: string;
}): Promise<FactoryRunRow> {
  const row = await queryOne<FactoryRunRow>(sql`
    INSERT INTO app.factory_runs (
      organization_id, flow_key, flow_version, model_id, work_item_id, delivery_id, change_id,
      automation_id, parent_run_id, trigger, actor_user_id, idempotency_key
    ) VALUES (
      ${input.organizationId}, ${input.flowKey}, ${input.flowVersion}, ${input.modelId ?? null},
      ${input.workItemId ?? null}, ${input.deliveryId ?? null}, ${input.changeId ?? null},
      ${input.automationId ?? null}, ${input.parentRunId ?? null}, ${input.trigger},
      ${input.actorUserId ?? null}, ${input.idempotencyKey}
    )
    ON CONFLICT(organization_id, idempotency_key) DO UPDATE
      SET idempotency_key = excluded.idempotency_key
    RETURNING *
  `);
  if (!row) throw new Error('factory run insert returned no row');
  return row;
}

export async function getFactoryRun(id: number): Promise<FactoryRunRow | null> {
  return queryOne<FactoryRunRow>(sql`SELECT * FROM app.factory_runs WHERE id = ${id}`);
}

export async function listFactoryRunsById(ids: readonly number[]): Promise<FactoryRunRow[]> {
  if (ids.length === 0) return [];
  return queryRows<FactoryRunRow>(sql`
    SELECT * FROM app.factory_runs WHERE id IN (${sqlValueList(ids)}) ORDER BY id DESC
  `);
}

export async function listFactoryRuns(input: {
  workItemId?: number;
  deliveryId?: number;
  changeId?: number;
  automationId?: number;
}): Promise<FactoryRunRow[]> {
  return queryRows<FactoryRunRow>(sql`
    SELECT * FROM app.factory_runs
    WHERE (${input.workItemId ?? null}::bigint IS NULL OR work_item_id = ${input.workItemId ?? null})
      AND (${input.deliveryId ?? null}::bigint IS NULL OR delivery_id = ${input.deliveryId ?? null})
      AND (${input.changeId ?? null}::bigint IS NULL OR change_id = ${input.changeId ?? null})
      AND (${input.automationId ?? null}::bigint IS NULL OR automation_id = ${input.automationId ?? null})
    ORDER BY id DESC
  `);
}

export async function updateFactoryRunStatus(id: number, status: FactoryRunStatus): Promise<void> {
  await execute(sql`
    UPDATE app.factory_runs SET status = ${status},
      started_at = CASE WHEN ${status} = 'running' THEN COALESCE(started_at, CURRENT_TIMESTAMP)
        ELSE started_at END,
      completed_at = CASE WHEN ${status} IN ('succeeded', 'failed', 'cancelled')
        THEN CURRENT_TIMESTAMP ELSE NULL END
    WHERE id = ${id}
  `);
}

export async function createStageRun(input: {
  organizationId: string;
  factoryRunId: number;
  stageKey: string;
  attempt: number;
  idempotencyKey: string;
}): Promise<StageRunRow> {
  const row = await queryOne<StageRunRow>(sql`
    INSERT INTO app.stage_runs (
      organization_id, factory_run_id, stage_key, attempt, idempotency_key
    ) VALUES (
      ${input.organizationId}, ${input.factoryRunId}, ${input.stageKey}, ${input.attempt},
      ${input.idempotencyKey}
    )
    ON CONFLICT(idempotency_key) DO UPDATE SET idempotency_key = excluded.idempotency_key
    RETURNING *
  `);
  if (!row) throw new Error('stage run insert returned no row');
  return row;
}

export async function getStageRun(id: number): Promise<StageRunRow | null> {
  return queryOne<StageRunRow>(sql`SELECT * FROM app.stage_runs WHERE id = ${id}`);
}

export async function listStageRuns(factoryRunId: number): Promise<StageRunRow[]> {
  return queryRows<StageRunRow>(sql`
    SELECT * FROM app.stage_runs WHERE factory_run_id = ${factoryRunId} ORDER BY id
  `);
}

export async function listStageRunsForFactoryRuns(
  factoryRunIds: readonly number[],
): Promise<StageRunRow[]> {
  if (factoryRunIds.length === 0) return [];
  return queryRows<StageRunRow>(sql`
    SELECT * FROM app.stage_runs
    WHERE factory_run_id IN (${sqlValueList(factoryRunIds)})
    ORDER BY factory_run_id, id
  `);
}

export async function listRecoverableFactoryStages(limit = 100): Promise<QueuedFactoryStageRow[]> {
  return queryRows<QueuedFactoryStageRow>(sql`
    SELECT factory.id AS factory_run_id, stage.id AS stage_run_id
    FROM app.stage_runs stage
    JOIN app.factory_runs factory
      ON factory.id = stage.factory_run_id
      AND factory.organization_id = stage.organization_id
    WHERE (
        stage.status = 'queued'
        OR (stage.status = 'running' AND stage.started_at < CURRENT_TIMESTAMP - INTERVAL '2 hours')
      )
      AND factory.status IN ('queued', 'running')
    ORDER BY stage.created_at, stage.id
    LIMIT ${limit}
  `);
}

export async function listLifecycleEvents(factoryRunId: number): Promise<LifecycleEventRow[]> {
  return queryRows<LifecycleEventRow>(sql`
    SELECT * FROM app.lifecycle_events WHERE factory_run_id = ${factoryRunId} ORDER BY id
  `);
}

export async function listLifecycleEventsForFactoryRuns(
  factoryRunIds: readonly number[],
): Promise<LifecycleEventRow[]> {
  if (factoryRunIds.length === 0) return [];
  return queryRows<LifecycleEventRow>(sql`
    SELECT * FROM app.lifecycle_events
    WHERE factory_run_id IN (${sqlValueList(factoryRunIds)})
    ORDER BY factory_run_id, id
  `);
}

export async function claimStageRun(id: number): Promise<boolean> {
  const row = await queryOne<{ id: number }>(sql`
    UPDATE app.stage_runs SET status = 'running', started_at = CURRENT_TIMESTAMP
    WHERE id = ${id} AND status = 'queued'
    RETURNING id
  `);
  return row !== null;
}

export async function finishStageRun(
  id: number,
  status: Extract<StageRunStatus, 'succeeded' | 'failed' | 'skipped' | 'cancelled'>,
  error?: { code: string; message: string },
): Promise<void> {
  await execute(sql`
    UPDATE app.stage_runs SET status = ${status}, error_code = ${error?.code ?? null},
      error_message = ${error?.message ?? null}, completed_at = CURRENT_TIMESTAMP
    WHERE id = ${id}
  `);
}

export async function waitStageRun(id: number): Promise<void> {
  await execute(sql`
    UPDATE app.stage_runs SET status = 'waiting'
    WHERE id = ${id} AND status = 'running'
  `);
}

export async function createAgentRun(input: {
  organizationId: string;
  stageRunId: number;
  agentId: number;
  modelId: number;
  inputArtifactId: number;
  idempotencyKey: string;
}): Promise<AgentRunRow> {
  const row = await queryOne<AgentRunRow>(sql`
    INSERT INTO app.agent_runs (
      organization_id, stage_run_id, agent_id, model_id, input_artifact_id, idempotency_key
    ) VALUES (
      ${input.organizationId}, ${input.stageRunId}, ${input.agentId}, ${input.modelId},
      ${input.inputArtifactId}, ${input.idempotencyKey}
    )
    ON CONFLICT(idempotency_key) DO UPDATE SET idempotency_key = excluded.idempotency_key
    RETURNING *
  `);
  if (!row) throw new Error('agent run insert returned no row');
  return row;
}

export async function getAgentRun(id: number): Promise<AgentRunRow | null> {
  return queryOne<AgentRunRow>(sql`SELECT * FROM app.agent_runs WHERE id = ${id}`);
}

export async function listAgentRunsForStage(stageRunId: number): Promise<AgentRunRow[]> {
  return queryRows<AgentRunRow>(sql`
    SELECT * FROM app.agent_runs WHERE stage_run_id = ${stageRunId} ORDER BY id
  `);
}

export async function listAgentRunsForFactoryRun(factoryRunId: number): Promise<AgentRunRow[]> {
  return queryRows<AgentRunRow>(sql`
    SELECT agent_run.*
    FROM app.agent_runs agent_run
    JOIN app.stage_runs stage_run ON stage_run.id = agent_run.stage_run_id
      AND stage_run.organization_id = agent_run.organization_id
    WHERE stage_run.factory_run_id = ${factoryRunId}
    ORDER BY agent_run.id
  `);
}

export async function listAgentRunsForFactoryRuns(
  factoryRunIds: readonly number[],
): Promise<AgentRunRow[]> {
  if (factoryRunIds.length === 0) return [];
  return queryRows<AgentRunRow>(sql`
    SELECT agent_run.*
    FROM app.agent_runs agent_run
    JOIN app.stage_runs stage_run ON stage_run.id = agent_run.stage_run_id
      AND stage_run.organization_id = agent_run.organization_id
    WHERE stage_run.factory_run_id IN (${sqlValueList(factoryRunIds)})
    ORDER BY stage_run.factory_run_id, agent_run.id
  `);
}

export async function latestPlanArtifactIdForWorkItem(workItemId: number): Promise<number | null> {
  const row = await queryOne<{ output_artifact_id: number }>(sql`
    SELECT agent_run.output_artifact_id
    FROM app.factory_runs factory_run
    JOIN app.stage_runs stage_run ON stage_run.factory_run_id = factory_run.id
      AND stage_run.organization_id = factory_run.organization_id
    JOIN app.agent_runs agent_run ON agent_run.stage_run_id = stage_run.id
      AND agent_run.organization_id = factory_run.organization_id
    JOIN app.artifacts artifact ON artifact.id = agent_run.output_artifact_id
      AND artifact.organization_id = factory_run.organization_id
    WHERE factory_run.work_item_id = ${workItemId}
      AND factory_run.flow_key = 'work_item'
      AND stage_run.stage_key = 'plan'
      AND agent_run.status = 'succeeded'
      AND artifact.kind = 'plan'
    ORDER BY factory_run.id DESC, stage_run.id DESC, agent_run.id DESC
    LIMIT 1
  `);
  return row?.output_artifact_id ?? null;
}

export async function artifactWasProducedForWorkItem(
  artifactId: number,
  workItemId: number,
): Promise<boolean> {
  const row = await queryOne<{ produced: boolean }>(sql`
    SELECT EXISTS(
      SELECT 1
      FROM app.agent_runs agent_run
      JOIN app.stage_runs stage_run ON stage_run.id = agent_run.stage_run_id
        AND stage_run.organization_id = agent_run.organization_id
      JOIN app.factory_runs factory_run ON factory_run.id = stage_run.factory_run_id
        AND factory_run.organization_id = stage_run.organization_id
      WHERE agent_run.output_artifact_id = ${artifactId}
        AND factory_run.work_item_id = ${workItemId}
        AND agent_run.status = 'succeeded'
    ) AS produced
  `);
  return row?.produced ?? false;
}

export async function findWaitingRunForWorkItemPlan(
  workItemId: number,
  artifactId: number,
  flow: { flowKey: string; flowVersion: number; stageKey: string },
): Promise<{ factoryRun: FactoryRunRow; stageRun: StageRunRow } | null> {
  const row = await queryOne<FactoryRunRow & { stage_run_id: number }>(sql`
    SELECT factory_run.*, stage_run.id AS stage_run_id
    FROM app.agent_runs agent_run
    JOIN app.stage_runs stage_run ON stage_run.id = agent_run.stage_run_id
      AND stage_run.organization_id = agent_run.organization_id
    JOIN app.factory_runs factory_run ON factory_run.id = stage_run.factory_run_id
      AND factory_run.organization_id = stage_run.organization_id
    WHERE agent_run.output_artifact_id = ${artifactId}
      AND agent_run.status = 'succeeded'
      AND factory_run.work_item_id = ${workItemId}
      AND factory_run.flow_key = ${flow.flowKey}
      AND factory_run.flow_version = ${flow.flowVersion}
      AND factory_run.status = 'waiting'
      AND stage_run.stage_key = ${flow.stageKey}
      AND stage_run.status = 'waiting'
    ORDER BY factory_run.id DESC
    LIMIT 1
  `);
  if (!row) return null;
  const stageRun = await getStageRun(row.stage_run_id);
  if (!stageRun) return null;
  return { factoryRun: row, stageRun };
}

export async function resumeFactoryRunAtStage(input: {
  factoryRunId: number;
  waitingStageRunId: number;
  nextStageKey: string;
  gate: string;
}): Promise<StageRunRow> {
  return withTransaction(async () => {
    const run = await queryOne<FactoryRunRow>(sql`
      SELECT * FROM app.factory_runs WHERE id = ${input.factoryRunId} FOR UPDATE
    `);
    if (!run || run.status !== 'waiting') throw new Error('factory run is not waiting');
    const waiting = await queryOne<StageRunRow>(sql`
      SELECT * FROM app.stage_runs
      WHERE id = ${input.waitingStageRunId} AND factory_run_id = ${run.id}
      FOR UPDATE
    `);
    if (!waiting || waiting.status !== 'waiting') throw new Error('factory stage is not waiting');

    await finishStageRun(waiting.id, 'succeeded');
    const next = await createStageRun({
      organizationId: run.organization_id,
      factoryRunId: run.id,
      stageKey: input.nextStageKey,
      attempt: 1,
      idempotencyKey: `${run.id}:${input.nextStageKey}:1`,
    });
    await updateFactoryRunStatus(run.id, 'queued');
    await recordLifecycleEvent({
      organizationId: run.organization_id,
      factoryRunId: run.id,
      stageRunId: waiting.id,
      kind: 'gate_passed',
      payload: { gate: input.gate, nextStage: input.nextStageKey },
    });
    return next;
  });
}

export async function claimAgentRun(id: number): Promise<boolean> {
  const row = await queryOne<{ id: number }>(sql`
    UPDATE app.agent_runs SET status = 'running', started_at = CURRENT_TIMESTAMP
    WHERE id = ${id} AND status = 'queued'
    RETURNING id
  `);
  return row !== null;
}

export async function completeAgentRun(input: {
  id: number;
  outputArtifactId: number;
  logArtifactId?: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}): Promise<void> {
  await execute(sql`
    UPDATE app.agent_runs SET status = 'succeeded', output_artifact_id = ${input.outputArtifactId},
      log_artifact_id = ${input.logArtifactId ?? null}, input_tokens = ${input.inputTokens},
      output_tokens = ${input.outputTokens}, cache_read_tokens = ${input.cacheReadTokens},
      cache_write_tokens = ${input.cacheWriteTokens}, cost_usd = ${input.costUsd},
      completed_at = CURRENT_TIMESTAMP
    WHERE id = ${input.id} AND status = 'running'
  `);
}

export async function failAgentRun(
  id: number,
  error: { code: string; message: string; logArtifactId?: number },
): Promise<void> {
  await execute(sql`
    UPDATE app.agent_runs SET status = 'failed', error_code = ${error.code},
      error_message = ${error.message}, log_artifact_id = ${error.logArtifactId ?? null},
      completed_at = CURRENT_TIMESTAMP
    WHERE id = ${id} AND status IN ('queued', 'running')
  `);
}

export async function recordLifecycleEvent(input: {
  organizationId: string;
  factoryRunId: number;
  stageRunId?: number;
  kind: string;
  payload?: unknown;
}): Promise<void> {
  await execute(sql`
    INSERT INTO app.lifecycle_events (
      organization_id, factory_run_id, stage_run_id, kind, payload
    ) VALUES (
      ${input.organizationId}, ${input.factoryRunId}, ${input.stageRunId ?? null}, ${input.kind},
      ${JSON.stringify(input.payload ?? {})}::jsonb
    )
  `);
}

export async function createFactoryRunWithStage(
  run: Parameters<typeof createFactoryRun>[0],
  stage: { stageKey: string; attempt?: number; idempotencyKey: string },
): Promise<{ factoryRun: FactoryRunRow; stageRun: StageRunRow }> {
  return withTransaction(async () => {
    const factoryRun = await createFactoryRun(run);
    const stageRun = await createStageRun({
      organizationId: factoryRun.organization_id,
      factoryRunId: factoryRun.id,
      stageKey: stage.stageKey,
      attempt: stage.attempt ?? 1,
      idempotencyKey: stage.idempotencyKey,
    });
    return { factoryRun, stageRun };
  });
}

export function listDeliveryFactoryRuns(deliveryId: number): Promise<FactoryRunRow[]> {
  return queryRows(sql`SELECT run.* FROM app.factory_runs run
    WHERE run.delivery_id = ${deliveryId} OR EXISTS (
      SELECT 1 FROM app.changes change WHERE change.id = run.change_id
        AND change.organization_id = run.organization_id AND change.delivery_id = ${deliveryId}
    ) ORDER BY run.id DESC`);
}
