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
  cursor: string;
  board_column: 'in_progress' | 'done';
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
  activeBefore?: string;
  historyBefore?: string;
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
  const [activeDate, activeId] = cursors.activeBefore?.split('|') ?? [];
  const [historyDate, historyId] = cursors.historyBefore?.split('|') ?? [];
  const rows = await read<BoardItemRow>(sql`
    WITH visible AS NOT MATERIALIZED (
      SELECT wi.id, wi.organization_id, wi.title,
        CASE WHEN wi.status = 'open' THEN NULLIF(wi.description, wi.title) ELSE NULL END AS notes,
        wi.status, wi.created_at,
        to_char(wi.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || wi.id AS cursor,
        CASE WHEN (
          EXISTS (SELECT 1 FROM app.work_item_targets t
            WHERE t.work_item_id = wi.id AND t.organization_id = wi.organization_id)
          AND NOT EXISTS (
            SELECT 1 FROM app.work_item_targets t
            LEFT JOIN app.deliveries d ON d.work_item_id = t.work_item_id
              AND d.repository_id = t.repository_id AND d.organization_id = t.organization_id
            LEFT JOIN LATERAL (
              SELECT status FROM app.changes
              WHERE delivery_id = d.id AND organization_id = wi.organization_id
              ORDER BY updated_at DESC, id DESC LIMIT 1
            ) c ON true
            WHERE t.work_item_id = wi.id AND t.organization_id = wi.organization_id
              AND NOT COALESCE(c.status = 'merged', false)
          )
        ) THEN 'done' ELSE 'in_progress' END AS board_column
      FROM app.work_items wi
      WHERE wi.organization_id IN (${organizations}) AND wi.status <> 'cancelled' AND wi.archived_at IS NULL
    )
    (SELECT * FROM visible WHERE board_column = 'in_progress'
      AND (${activeDate ?? null}::timestamptz IS NULL OR (created_at, id) < (${activeDate ?? null}::timestamptz, ${activeId ?? null}::bigint))
      ORDER BY created_at DESC, id DESC LIMIT ${ACTIVE_PAGE_SIZE + 1})
    UNION ALL
    (SELECT * FROM visible WHERE board_column = 'done'
      AND (${historyDate ?? null}::timestamptz IS NULL OR (created_at, id) < (${historyDate ?? null}::timestamptz, ${historyId ?? null}::bigint))
      ORDER BY created_at DESC, id DESC LIMIT ${HISTORY_PAGE_SIZE + 1})
  `);
  const newestFirst = (a: BoardItemRow, b: BoardItemRow) =>
    b.cursor.split('|')[0]!.localeCompare(a.cursor.split('|')[0]!) || b.id - a.id;
  const active = rows.filter((row) => row.board_column === 'in_progress').sort(newestFirst);
  const history = rows.filter((row) => row.board_column === 'done').sort(newestFirst);
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
      column: item.board_column,
      createdAt: item.cursor.split('|')[0]!,
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
    activeNextBefore:
      active.length > ACTIVE_PAGE_SIZE ? active[ACTIVE_PAGE_SIZE - 1]!.cursor : null,
    historyNextBefore:
      history.length > HISTORY_PAGE_SIZE ? history[HISTORY_PAGE_SIZE - 1]!.cursor : null,
  };
}
