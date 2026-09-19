import { isJsonObject } from '../shared/json.ts';
import { sql } from 'drizzle-orm';
import { queryOne, queryRows, withTransaction } from './postgres.ts';
import {
  getChange,
  latestChangeRevision,
  type ChangeRevisionRow,
  type ChangeRow,
} from './changes.ts';
import {
  createFactoryRun,
  createStageRun,
  finishStageRun,
  getStageRun,
  listLifecycleEvents,
  listStageRuns,
  recordLifecycleEvent,
  updateFactoryRunStatus,
  type FactoryRunRow,
  type LifecycleEventRow,
  type StageRunRow,
} from './execution.ts';
import type { DeliveryDecision } from '../domain/delivery-lifecycle.ts';

export function deliveryCandidates(): Promise<Array<{ id: number }>> {
  return queryRows(sql`SELECT c.id FROM app.changes c
    JOIN app.repositories r ON r.id = c.repository_id AND r.organization_id = c.organization_id
    WHERE c.delivery_id IS NOT NULL AND c.status = 'open' AND r.enabled
      AND r.settings->>'processProfile' IN ('assisted_delivery', 'full_delivery')
    ORDER BY c.updated_at, c.id LIMIT 100`);
}

export async function withDeliveryLock<T>(
  changeId: number,
  operation: (change: ChangeRow) => Promise<T>,
): Promise<T | null> {
  return withTransaction(async () => {
    await queryOne(sql`SELECT id FROM app.changes WHERE id = ${changeId} FOR UPDATE`);
    const change = await getChange(changeId);
    return change ? operation(change) : null;
  });
}

export async function deliveryRun(change: ChangeRow): Promise<FactoryRunRow> {
  const parent = await queryOne<FactoryRunRow>(sql`SELECT * FROM app.factory_runs
    WHERE delivery_id = ${change.delivery_id} AND organization_id = ${change.organization_id}
    ORDER BY id DESC LIMIT 1`);
  return createFactoryRun({
    organizationId: change.organization_id,
    flowKey: 'change_delivery',
    flowVersion: 1,
    changeId: change.id,
    parentRunId: parent?.id,
    modelId: parent?.model_id ?? undefined,
    trigger: 'delivery',
    idempotencyKey: `change-delivery:${change.id}`,
  });
}

export async function applyDeliveryDecision(
  run: FactoryRunRow,
  revision: ChangeRevisionRow,
  decision: DeliveryDecision,
): Promise<StageRunRow | null> {
  const stages = await listStageRuns(run.id);
  if (stages.some((stage) => stage.status === 'queued' || stage.status === 'running')) return null;
  if (decision.kind === 'stage') {
    const attempt = stages.filter((stage) => stage.stage_key === decision.operation).length + 1;
    const stage = await createStageRun({
      organizationId: run.organization_id,
      factoryRunId: run.id,
      stageKey: decision.operation,
      attempt,
      idempotencyKey: `${run.id}:${decision.operation}:${attempt}`,
    });
    await updateFactoryRunStatus(run.id, 'queued');
    await recordLifecycleEvent({
      organizationId: run.organization_id,
      factoryRunId: run.id,
      stageRunId: stage.id,
      kind: 'delivery_stage_scheduled',
      payload: { revisionId: revision.id, reason: decision.reason },
    });
    return stage;
  }
  const events = await listLifecycleEvents(run.id);
  const payload = { revisionId: revision.id, reason: decision.reason };
  const previous = events.at(-1)?.payload;
  if (
    !isJsonObject(previous) ||
    previous.revisionId !== revision.id ||
    previous.reason !== decision.reason
  ) {
    await recordLifecycleEvent({
      organizationId: run.organization_id,
      factoryRunId: run.id,
      kind: decision.kind === 'complete' ? 'delivery_ready' : 'delivery_waiting',
      payload,
    });
  }
  await updateFactoryRunStatus(run.id, decision.kind === 'complete' ? 'succeeded' : 'waiting');
  return null;
}

/** Completion and evidence become visible together, including on Workflow retries. */
export async function completeDeliveryStage(
  run: FactoryRunRow,
  stage: StageRunRow,
  payload: {
    revisionId: number;
    verdict: string;
    artifactId?: number;
    reason?: string;
  },
): Promise<void> {
  await withDeliveryLock(run.change_id!, async () => {
    if ((await getStageRun(stage.id))?.status !== 'running') return;
    await finishStageRun(stage.id, 'succeeded');
    await updateFactoryRunStatus(run.id, 'waiting');
    await recordLifecycleEvent({
      organizationId: run.organization_id,
      factoryRunId: run.id,
      stageRunId: stage.id,
      kind: 'delivery_stage_completed',
      payload,
    });
  });
}

export async function resumeDeliveryRun(change: ChangeRow): Promise<StageRunRow> {
  const stage = await withDeliveryLock(change.id, async () => {
    const run = await deliveryRun(change);
    const stages = await listStageRuns(run.id);
    const active = stages.find((stage) => ['queued', 'running'].includes(stage.status));
    if (active) return active;
    const revision = await latestChangeRevision(change.id);
    if (!revision) throw new Error('Change has no immutable revision');
    await recordLifecycleEvent({
      organizationId: run.organization_id,
      factoryRunId: run.id,
      kind: 'delivery_resumed',
      payload: { revisionId: revision.id },
    });
    const next = await createStageRun({
      organizationId: run.organization_id,
      factoryRunId: run.id,
      stageKey: 'reconcile',
      attempt: stages.filter((stage) => stage.stage_key === 'reconcile').length + 1,
      idempotencyKey: `resume:${run.id}:${stages.length}`,
    });
    await recordLifecycleEvent({
      organizationId: run.organization_id,
      factoryRunId: run.id,
      stageRunId: next.id,
      kind: 'delivery_stage_scheduled',
      payload: { revisionId: revision.id, reason: 'Human requested delivery resumption.' },
    });
    await updateFactoryRunStatus(run.id, 'queued');
    return next;
  });
  if (!stage) throw new Error('Change disappeared');
  return stage;
}

export function latestVerificationEvent(
  changeId: number,
  revisionId: number,
): Promise<LifecycleEventRow | null> {
  return queryOne(sql`SELECT event.* FROM app.lifecycle_events event
    JOIN app.factory_runs run ON run.id = event.factory_run_id AND run.organization_id = event.organization_id
    JOIN app.stage_runs stage ON stage.id = event.stage_run_id AND stage.organization_id = event.organization_id
    WHERE run.change_id = ${changeId} AND run.flow_key = 'change_delivery' AND stage.stage_key = 'verify'
      AND event.kind = 'delivery_stage_completed' AND event.payload->>'revisionId' = ${String(revisionId)}
      AND event.payload ? 'artifactId'
    ORDER BY event.id DESC LIMIT 1`);
}
