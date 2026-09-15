import { sql } from 'drizzle-orm';
import { execute, queryOne, queryRows, sqlValueList, withTransaction } from './postgres.ts';
import type { ArtifactRow } from './artifacts.ts';
import { getRepository, type RepositoryRow } from './repositories.ts';

export type WorkItemStatus =
  | 'open'
  | 'planning'
  | 'awaiting_approval'
  | 'approved'
  | 'in_progress'
  | 'completed'
  | 'cancelled';

export interface WorkItemAttachmentRow {
  work_item_id: number;
  artifact_id: number;
  name: string;
}

export async function listWorkItemAttachments(
  workItemIds: number[],
): Promise<WorkItemAttachmentRow[]> {
  if (workItemIds.length === 0) return [];
  return queryRows<WorkItemAttachmentRow>(sql`
    SELECT DISTINCT factory.work_item_id, (attachment->>'artifactId')::bigint AS artifact_id,
      attachment->>'name' AS name
    FROM app.factory_runs factory
    JOIN app.lifecycle_events event ON event.factory_run_id = factory.id
      AND event.organization_id = factory.organization_id
    CROSS JOIN LATERAL jsonb_array_elements(event.payload->'attachments') attachment
    WHERE factory.work_item_id IN (${sqlValueList(workItemIds)})
      AND event.kind = 'factory_run_requested'
      AND jsonb_typeof(event.payload->'attachments') = 'array'
    ORDER BY factory.work_item_id, artifact_id
  `);
}

export interface WorkItemRow {
  id: number;
  organization_id: string;
  origin: 'idea' | 'issue' | 'external_change' | 'automation' | 'api';
  title: string;
  description: string;
  status: WorkItemStatus;
  approved_plan_artifact_id: number | null;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface WorkItemTargetRow {
  work_item_id: number;
  repository_id: number;
  organization_id: string;
  position: number;
  created_at: string;
  owner: string;
  name: string;
}

export interface DeliveryRow {
  id: number;
  organization_id: string;
  work_item_id: number;
  repository_id: number;
  status: 'pending' | 'active' | 'completed' | 'failed' | 'cancelled';
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface AcceptanceContractRow {
  id: number;
  organization_id: string;
  delivery_id: number;
  version: number;
  artifact_id: number;
  status: 'proposed' | 'active' | 'rejected' | 'superseded';
  created_by_user_id: string | null;
  created_at: string;
}

export async function listWorkItems(organizationIds: string[]): Promise<WorkItemRow[]> {
  if (organizationIds.length === 0) return [];
  return queryRows<WorkItemRow>(sql`
    SELECT * FROM app.work_items
    WHERE organization_id IN (${sqlValueList(organizationIds)})
    ORDER BY created_at DESC, id DESC
  `);
}

export async function getWorkItem(id: number): Promise<WorkItemRow | null> {
  return queryOne<WorkItemRow>(sql`SELECT * FROM app.work_items WHERE id = ${id}`);
}

export async function listWorkItemTargets(workItemIds: number[]): Promise<WorkItemTargetRow[]> {
  if (workItemIds.length === 0) return [];
  return queryRows<WorkItemTargetRow>(sql`
    SELECT wit.*, r.owner, r.name
    FROM app.work_item_targets wit
    JOIN app.repositories r ON r.id = wit.repository_id
    WHERE wit.work_item_id IN (${sqlValueList(workItemIds)})
    ORDER BY wit.work_item_id, wit.position
  `);
}

export async function createWorkItem(input: {
  organizationId: string;
  origin: WorkItemRow['origin'];
  title: string;
  description: string;
  createdByUserId?: string | null;
  repositoryIds: number[];
}): Promise<WorkItemRow> {
  return withTransaction(async (transaction) => {
    const inserted = await transaction.execute<
      WorkItemRow & Record<string, string | number | null>
    >(sql`
      INSERT INTO app.work_items (
        organization_id, origin, title, description, created_by_user_id
      ) VALUES (
        ${input.organizationId}, ${input.origin}, ${input.title}, ${input.description},
        ${input.createdByUserId ?? null}
      )
      RETURNING *
    `);
    const row = inserted.rows[0];
    if (!row) throw new Error('work item insert returned no row');
    for (const [position, repositoryId] of input.repositoryIds.entries()) {
      await transaction.execute(sql`
        INSERT INTO app.work_item_targets (
          work_item_id, repository_id, organization_id, position
        ) VALUES (${row.id}, ${repositoryId}, ${input.organizationId}, ${position})
      `);
    }
    return row;
  });
}

export async function updateWorkItem(
  id: number,
  input: { title?: string; description?: string; status?: WorkItemStatus },
): Promise<void> {
  await execute(sql`
    UPDATE app.work_items SET
      title = COALESCE(${input.title ?? null}, title),
      description = COALESCE(${input.description ?? null}, description),
      status = COALESCE(${input.status ?? null}, status),
      completed_at = CASE
        WHEN ${input.status ?? null} IN ('completed', 'cancelled') THEN CURRENT_TIMESTAMP
        WHEN ${input.status ?? null}::text IS NOT NULL THEN NULL
        ELSE completed_at
      END,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${id}
  `);
}

export async function replaceWorkItemTargets(
  workItem: WorkItemRow,
  repositoryIds: number[],
): Promise<void> {
  await withTransaction(async (transaction) => {
    await transaction.execute(sql`
      SELECT id FROM app.work_items WHERE id = ${workItem.id} FOR UPDATE
    `);
    const started = await transaction.execute(sql`
      SELECT 1 FROM app.factory_runs WHERE work_item_id = ${workItem.id} LIMIT 1
    `);
    if (started.rows.length > 0) throw new Error('work item has already started');
    await transaction.execute(sql`
      DELETE FROM app.work_item_targets WHERE work_item_id = ${workItem.id}
    `);
    for (const [position, repositoryId] of repositoryIds.entries()) {
      await transaction.execute(sql`
        INSERT INTO app.work_item_targets (
          work_item_id, repository_id, organization_id, position
        ) VALUES (${workItem.id}, ${repositoryId}, ${workItem.organization_id}, ${position})
      `);
    }
  });
}

export async function deleteUnstartedWorkItem(id: number): Promise<boolean> {
  const row = await queryOne<{ id: number }>(sql`
    DELETE FROM app.work_items wi
    WHERE wi.id = ${id}
      AND NOT EXISTS (SELECT 1 FROM app.factory_runs fr WHERE fr.work_item_id = wi.id)
    RETURNING wi.id
  `);
  return row !== null;
}

export async function approveWorkItemPlan(
  workItemId: number,
  artifact: ArtifactRow,
): Promise<void> {
  await execute(sql`
    UPDATE app.work_items SET approved_plan_artifact_id = ${artifact.id}, status = 'approved',
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${workItemId} AND organization_id = ${artifact.organization_id}
  `);
}

export async function createDeliveries(workItem: WorkItemRow): Promise<DeliveryRow[]> {
  return queryRows<DeliveryRow>(sql`
    INSERT INTO app.deliveries (organization_id, work_item_id, repository_id)
    SELECT organization_id, work_item_id, repository_id
    FROM app.work_item_targets
    WHERE work_item_id = ${workItem.id}
    ON CONFLICT(work_item_id, repository_id) DO NOTHING
    RETURNING *
  `);
}

export async function listDeliveriesForWorkItem(workItemId: number): Promise<DeliveryRow[]> {
  return queryRows<DeliveryRow>(sql`
    SELECT * FROM app.deliveries WHERE work_item_id = ${workItemId} ORDER BY id
  `);
}

export async function getDelivery(id: number): Promise<DeliveryRow | null> {
  return queryOne<DeliveryRow>(sql`SELECT * FROM app.deliveries WHERE id = ${id}`);
}

export async function getDeliveryRepository(id: number): Promise<RepositoryRow | null> {
  const delivery = await getDelivery(id);
  return delivery ? getRepository(delivery.repository_id) : null;
}

export async function updateDeliveryStatus(
  id: number,
  status: DeliveryRow['status'],
): Promise<void> {
  await execute(sql`
    UPDATE app.deliveries SET status = ${status},
      completed_at = CASE WHEN ${status} IN ('completed', 'failed', 'cancelled')
        THEN CURRENT_TIMESTAMP ELSE NULL END,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${id}
  `);
}

export async function completeWorkItemWhenDelivered(workItemId: number): Promise<void> {
  await execute(sql`
    UPDATE app.work_items work_item
    SET status = 'completed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE work_item.id = ${workItemId}
      AND EXISTS (
        SELECT 1 FROM app.deliveries delivery WHERE delivery.work_item_id = work_item.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM app.deliveries delivery
        WHERE delivery.work_item_id = work_item.id AND delivery.status <> 'completed'
      )
  `);
}

export async function createAcceptanceContract(input: {
  delivery: DeliveryRow;
  artifact: ArtifactRow;
  status: AcceptanceContractRow['status'];
  createdByUserId?: string | null;
}): Promise<AcceptanceContractRow> {
  return withTransaction(async (transaction) => {
    await transaction.execute(sql`
      SELECT id FROM app.deliveries WHERE id = ${input.delivery.id} FOR UPDATE
    `);
    if (input.status === 'active') {
      await transaction.execute(sql`
        UPDATE app.acceptance_contracts SET status = 'superseded'
        WHERE delivery_id = ${input.delivery.id} AND status = 'active'
      `);
    }
    const result = await transaction.execute<
      AcceptanceContractRow & Record<string, string | number | null>
    >(sql`
      INSERT INTO app.acceptance_contracts (
        organization_id, delivery_id, version, artifact_id, status, created_by_user_id
      ) VALUES (
        ${input.delivery.organization_id}, ${input.delivery.id},
        COALESCE((SELECT MAX(version) + 1 FROM app.acceptance_contracts
          WHERE delivery_id = ${input.delivery.id}), 1),
        ${input.artifact.id}, ${input.status}, ${input.createdByUserId ?? null}
      )
      RETURNING *
    `);
    const row = result.rows[0];
    if (!row) throw new Error('acceptance contract insert returned no row');
    return row;
  });
}

export async function activeAcceptanceContract(
  deliveryId: number,
): Promise<AcceptanceContractRow | null> {
  return queryOne<AcceptanceContractRow>(sql`
    SELECT * FROM app.acceptance_contracts
    WHERE delivery_id = ${deliveryId} AND status = 'active'
  `);
}
