import { sql } from 'drizzle-orm';
import { queryOne, queryRows, withTransaction } from './postgres.ts';
import {
  createFactoryRunWithStage,
  recordLifecycleEvent,
  type FactoryRunStatus,
} from './execution.ts';

export interface DeliveryMessageRow {
  id: number;
  delivery_id: number;
  organization_id: string;
  author_user_id: string | null;
  role: 'user' | 'assistant' | 'system';
  body: string;
  factory_run_id: number | null;
  outcome: 'changed' | 'no_changes' | null;
  commit_sha: string | null;
  created_at: string;
}

export interface DeliveryMessageWithRun extends DeliveryMessageRow {
  status: FactoryRunStatus | null;
  error: string | null;
}

export async function listDeliveryMessages(deliveryId: number): Promise<DeliveryMessageWithRun[]> {
  return queryRows<DeliveryMessageWithRun>(sql`
    SELECT message.*, factory.status, failed.error_message AS error
    FROM app.delivery_messages message
    LEFT JOIN app.factory_runs factory ON factory.id = message.factory_run_id
      AND factory.organization_id = message.organization_id
    LEFT JOIN LATERAL (
      SELECT error_message FROM app.stage_runs
      WHERE factory_run_id = factory.id AND error_message IS NOT NULL
      ORDER BY id DESC LIMIT 1
    ) failed ON true
    WHERE message.delivery_id = ${deliveryId} ORDER BY message.id
  `);
}

export async function createDeliveryMessage(input: {
  delivery: { id: number; organization_id: string };
  authorUserId?: string | null;
  role: DeliveryMessageRow['role'];
  body: string;
  factoryRunId?: number;
  outcome?: 'changed' | 'no_changes';
  commitSha?: string;
}): Promise<DeliveryMessageRow> {
  const row = await queryOne<DeliveryMessageRow>(sql`
    INSERT INTO app.delivery_messages (delivery_id, organization_id, author_user_id, role, body, factory_run_id, outcome, commit_sha)
    VALUES (
      ${input.delivery.id}, ${input.delivery.organization_id}, ${input.authorUserId ?? null},
      ${input.role}, ${input.body}, ${input.factoryRunId ?? null}, ${input.outcome ?? null}, ${input.commitSha ?? null}
    )
    ON CONFLICT (factory_run_id, role) DO UPDATE SET factory_run_id = excluded.factory_run_id
    RETURNING *
  `);
  if (!row) throw new Error('delivery message insert returned no row');
  return row;
}

// Lock the delivery while accepting a turn so separate tabs cannot start
// competing writers. The message and queued stage commit together; recovery
// can deliver the stage even if the queue is temporarily unavailable.
export async function createDeliveryChatTurn(input: {
  deliveryId: number;
  organizationId: string;
  authorUserId: string;
  body: string;
  flowKey: string;
  flowVersion: number;
  stageKey: string;
}) {
  return withTransaction(async () => {
    const delivery = await queryOne<{ id: number; organization_id: string; status: string }>(sql`
      SELECT id, organization_id, status FROM app.deliveries
      WHERE id = ${input.deliveryId} AND organization_id = ${input.organizationId} FOR UPDATE
    `);
    if (!delivery || delivery.status === 'cancelled') return { kind: 'unavailable' } as const;
    const change = await queryOne<{ id: number }>(sql`
      SELECT c.id FROM app.changes c
      JOIN app.repositories r ON r.id = c.repository_id AND r.organization_id = c.organization_id
      WHERE c.delivery_id = ${delivery.id} AND c.organization_id = ${delivery.organization_id}
        AND c.status = 'open' AND r.enabled = true
    `);
    if (!change) return { kind: 'unavailable' } as const;
    const active = await queryOne<{ id: number }>(sql`
      SELECT id FROM app.factory_runs WHERE delivery_id = ${delivery.id}
        AND status IN ('queued', 'running', 'waiting') LIMIT 1
    `);
    if (active) return { kind: 'busy' } as const;
    const key = `chat:${delivery.id}:${crypto.randomUUID()}`;
    const started = await createFactoryRunWithStage(
      {
        organizationId: delivery.organization_id,
        deliveryId: delivery.id,
        flowKey: input.flowKey,
        flowVersion: input.flowVersion,
        trigger: 'chat',
        actorUserId: input.authorUserId,
        idempotencyKey: key,
      },
      { stageKey: input.stageKey, idempotencyKey: `${key}:${input.stageKey}:1` },
    );
    const message = await createDeliveryMessage({
      delivery,
      authorUserId: input.authorUserId,
      role: 'user',
      body: input.body,
      factoryRunId: started.factoryRun.id,
    });
    await recordLifecycleEvent({
      organizationId: delivery.organization_id,
      factoryRunId: started.factoryRun.id,
      stageRunId: started.stageRun.id,
      kind: 'chat_queued',
      payload: { messageId: message.id },
    });
    return { kind: 'accepted', message, ...started } as const;
  });
}

export async function chatRequestForRun(factoryRunId: number): Promise<DeliveryMessageRow | null> {
  return queryOne<DeliveryMessageRow>(sql`
    SELECT * FROM app.delivery_messages WHERE factory_run_id = ${factoryRunId} AND role = 'user'
  `);
}

export async function deliveryChatContext(
  deliveryId: number,
  throughId: number,
): Promise<DeliveryMessageRow[]> {
  return queryRows<DeliveryMessageRow>(sql`
    SELECT * FROM (
      SELECT * FROM app.delivery_messages
      WHERE delivery_id = ${deliveryId} AND id <= ${throughId} AND role IN ('user', 'assistant')
      ORDER BY id DESC LIMIT 20
    ) recent ORDER BY id
  `);
}
