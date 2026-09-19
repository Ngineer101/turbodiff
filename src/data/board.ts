import { sql } from 'drizzle-orm';
import { queryRows, sqlValueList } from './postgres.ts';
import type { WorkItemStatus } from './work.ts';

const ACTIVE_PAGE_SIZE = 50;
const HISTORY_PAGE_SIZE = 25;

interface BoardItemRow {
  id: number;
  organization_id: string;
  title: string;
  notes: string | null;
  status: WorkItemStatus;
  created_at: string;
}
interface BoardTargetRow {
  work_item_id: number;
  repository_id: number;
  owner: string;
  name: string;
  provider: string;
  delivery_id: number | null;
  delivery_status: string | null;
  change_number: number | null;
  change_status: string | null;
}

export interface BoardCursors {
  activeBefore?: number;
  historyBefore?: number;
}

/** Two bounded, tenant-scoped reads. The board never hydrates runs or artifact bodies. */
export async function readBoardPage(
  organizationIds: readonly string[],
  cursors: BoardCursors = {},
  read: typeof queryRows = queryRows,
) {
  if (!organizationIds.length)
    return { items: [], activeNextBefore: null, historyNextBefore: null };
  const organizations = sqlValueList([...organizationIds]);
  const rows = await read<BoardItemRow>(sql`
    (SELECT id, organization_id, title, CASE WHEN status = 'open' THEN NULLIF(description, title) ELSE NULL END AS notes,
       status, created_at
     FROM app.work_items
     WHERE organization_id IN (${organizations}) AND status NOT IN ('completed', 'cancelled')
       AND (${cursors.activeBefore ?? null}::bigint IS NULL OR id < ${cursors.activeBefore ?? null})
     ORDER BY id DESC LIMIT ${ACTIVE_PAGE_SIZE + 1})
    UNION ALL
    (SELECT id, organization_id, title, NULL AS notes, status, created_at
     FROM app.work_items
     WHERE organization_id IN (${organizations}) AND status = 'completed'
       AND (${cursors.historyBefore ?? null}::bigint IS NULL OR id < ${cursors.historyBefore ?? null})
     ORDER BY id DESC LIMIT ${HISTORY_PAGE_SIZE + 1})
  `);
  const active = rows.filter((row) => row.status !== 'completed').sort((a, b) => b.id - a.id);
  const history = rows.filter((row) => row.status === 'completed').sort((a, b) => b.id - a.id);
  const items = [...active.slice(0, ACTIVE_PAGE_SIZE), ...history.slice(0, HISTORY_PAGE_SIZE)];
  const targets = items.length
    ? await read<BoardTargetRow>(sql`
    SELECT target.work_item_id, repository.id AS repository_id, repository.owner, repository.name,
      integration.provider, delivery.id AS delivery_id, delivery.status AS delivery_status,
      change.number AS change_number, change.status AS change_status
    FROM app.work_item_targets target
    JOIN app.repositories repository ON repository.id = target.repository_id AND repository.organization_id = target.organization_id
    JOIN app.integrations integration ON integration.id = repository.source_integration_id AND integration.organization_id = target.organization_id
    LEFT JOIN app.deliveries delivery ON delivery.work_item_id = target.work_item_id
      AND delivery.repository_id = target.repository_id AND delivery.organization_id = target.organization_id
    LEFT JOIN LATERAL (
      SELECT number, status FROM app.changes
      WHERE delivery_id = delivery.id AND organization_id = target.organization_id
      ORDER BY updated_at DESC, id DESC LIMIT 1
    ) change ON true
    WHERE target.organization_id IN (${organizations}) AND target.work_item_id IN (${sqlValueList(items.map((item) => item.id))})
    ORDER BY target.work_item_id, target.position
  `)
    : [];
  const byItem = new Map<number, BoardTargetRow[]>();
  for (const target of targets) {
    const existing = byItem.get(target.work_item_id);
    if (existing) existing.push(target);
    else byItem.set(target.work_item_id, [target]);
  }
  return {
    items: items.map((item) => ({
      id: item.id,
      organizationId: item.organization_id,
      title: item.title,
      notes: item.notes,
      status: item.status,
      createdAt: item.created_at,
      targets: (byItem.get(item.id) ?? []).map((target) => ({
        repositoryId: target.repository_id,
        owner: target.owner,
        name: target.name,
        provider: target.provider,
        deliveryId: target.delivery_id,
        deliveryStatus: target.delivery_status,
        changeNumber: target.change_number,
        changeStatus: target.change_status,
      })),
    })),
    activeNextBefore: active.length > ACTIVE_PAGE_SIZE ? active[ACTIVE_PAGE_SIZE - 1]!.id : null,
    historyNextBefore:
      history.length > HISTORY_PAGE_SIZE ? history[HISTORY_PAGE_SIZE - 1]!.id : null,
  };
}
