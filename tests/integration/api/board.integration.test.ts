import { sql, type SQL } from 'drizzle-orm';
import type { QueryResultRow } from 'pg';
import { describe, expect, it } from 'vite-plus/test';
import { createEffectApiHandler } from '../../../src/api/server/handler.ts';
import { readBoardPage } from '../../../src/data/board.ts';
import { recordArtifact } from '../../../src/data/artifacts.ts';
import { upsertChange } from '../../../src/data/changes.ts';
import { createFactoryRunWithStage, recordLifecycleEvent } from '../../../src/data/execution.ts';
import { execute, queryRows } from '../../../src/data/postgres.ts';
import {
  createWorkItem,
  createDeliveries,
  updateWorkItem,
  getWorkItem,
} from '../../../src/data/work.ts';
import { apiDependencies, createTenant, rollbackAfter } from './support.ts';

async function insertItems(organizationId: string, count: number, status: string) {
  return queryRows<{
    id: number;
  }>(sql`INSERT INTO app.work_items (organization_id, origin, title, description, status)
    SELECT ${organizationId}, 'idea', 'Item ' || n, 'Requirements ' || n, ${status}
    FROM generate_series(1, ${count}) n RETURNING id`);
}

describe('bounded factory board projection', () => {
  it('pages active work and completed history independently without leaking tenants or dropping older cards', () =>
    rollbackAfter(async () => {
      const owner = await createTenant();
      const stranger = await createTenant();
      const active = await insertItems(owner.organizationId, 51, 'open');
      const completed = await insertItems(owner.organizationId, 26, 'completed');
      await insertItems(owner.organizationId, 2, 'cancelled');
      const archived = await insertItems(owner.organizationId, 2, 'completed');
      for (const item of archived) await updateWorkItem(item.id, { archived: true });
      // Creation dates deliberately disagree with IDs, including sub-millisecond precision.
      for (const items of [active, completed]) {
        for (const [index, item] of items.entries()) {
          await execute(sql`UPDATE app.work_items
            SET created_at = '2026-01-01T00:00:00Z'::timestamptz + (${items.length - index} * interval '1 microsecond')
            WHERE id = ${item.id}`);
        }
      }
      await insertItems(stranger.organizationId, 80, 'open');
      await insertItems(stranger.organizationId, 80, 'completed');
      const page = await readBoardPage([owner.organizationId]);
      expect(page.items.filter((item) => item.status === 'open')).toHaveLength(50);
      expect(page.items.filter((item) => item.status === 'completed')).toHaveLength(25);
      expect(page.items.every((item) => item.organizationId === owner.organizationId)).toBe(true);
      expect(page.items.some((item) => item.status === 'cancelled')).toBe(false);
      expect(
        page.items.filter((item) => item.column === 'in_progress').map((item) => item.id),
      ).toEqual(active.slice(0, 50).map((item) => item.id));
      expect(page.items.filter((item) => item.column === 'done').map((item) => item.id)).toEqual(
        completed.slice(0, 25).map((item) => item.id),
      );
      expect(page.activeNextBefore).not.toBeNull();
      expect(page.historyNextBefore).not.toBeNull();
      const next = await readBoardPage([owner.organizationId], {
        activeBefore: page.activeNextBefore!,
        historyBefore: page.historyNextBefore!,
      });
      expect(next.items).toHaveLength(2);
      expect(next.activeNextBefore).toBeNull();
      expect(next.historyNextBefore).toBeNull();
      const ids = [...page.items, ...next.items].map((item) => item.id);
      expect(new Set(ids).size).toBe(77);
      expect(ids.sort((a, b) => a - b)).toEqual(
        [...active, ...completed].map((item) => item.id).sort((a, b) => a - b),
      );
      // New arrivals do not move a previously returned keyset cursor or duplicate older cards.
      await insertItems(owner.organizationId, 1, 'open');
      expect(
        await readBoardPage([owner.organizationId], {
          activeBefore: page.activeNextBefore!,
          historyBefore: page.historyNextBefore!,
        }),
      ).toEqual(next);
      expect(
        (
          await readBoardPage([owner.organizationId], { historyBefore: page.historyNextBefore! })
        ).items.filter((item) => item.status === 'open'),
      ).toHaveLength(50);
    }));

  it('classifies completed deliveries and merged changes before applying column page limits', () =>
    rollbackAfter(async () => {
      const tenant = await createTenant();
      // These IDs are older than every merged item, so late client-side classification would hide them.
      const active = await insertItems(tenant.organizationId, 51, 'in_progress');
      const merged = await insertItems(tenant.organizationId, 26, 'approved');
      for (const [index, item] of merged.entries()) {
        await execute(sql`INSERT INTO app.work_item_targets (work_item_id, repository_id, organization_id, position)
          VALUES (${item.id}, ${tenant.repositoryId}, ${tenant.organizationId}, 0)`);
        const row = (await getWorkItem(item.id))!;
        const [delivery] = await createDeliveries(row);
        const change = await upsertChange({
          organizationId: tenant.organizationId,
          repositoryId: tenant.repositoryId,
          deliveryId: delivery!.id,
          providerIntegrationId: tenant.integrationId,
          providerKey: `pull_request:${index + 1}`,
          number: index + 1,
          title: row.title,
          sourceRef: `turbodiff/${index}`,
          targetRef: 'main',
          origin: 'factory',
        });
        await execute(sql`UPDATE app.changes SET status = 'merged' WHERE id = ${change.id}`);
      }
      const page = await readBoardPage([tenant.organizationId]);
      expect(
        page.items.filter((item) => item.column === 'in_progress').map((item) => item.id),
      ).toEqual(
        active
          .slice(1)
          .reverse()
          .map((item) => item.id),
      );
      expect(page.items.filter((item) => item.column === 'done').map((item) => item.id)).toEqual(
        merged
          .slice(1)
          .reverse()
          .map((item) => item.id),
      );
      const next = await readBoardPage([tenant.organizationId], {
        activeBefore: page.activeNextBefore!,
        historyBefore: page.historyNextBefore!,
      });
      expect(next.items.map((item) => item.id)).toEqual([active[0]!.id, merged[0]!.id]);
      const [otherRepository] = await queryRows<{ id: number }>(sql`
        INSERT INTO app.repositories (organization_id, source_integration_id, external_id, owner, name)
        VALUES (${tenant.organizationId}, ${tenant.integrationId}, 'second-repo', 'test', 'second') RETURNING id
      `);
      await execute(sql`INSERT INTO app.work_item_targets (work_item_id, repository_id, organization_id, position)
        VALUES (${merged.at(-1)!.id}, ${otherRepository!.id}, ${tenant.organizationId}, 1)`);
      expect(
        (await readBoardPage([tenant.organizationId])).items.find(
          (item) => item.id === merged.at(-1)!.id,
        ),
      ).toMatchObject({ column: 'in_progress' });
      await execute(sql`DELETE FROM app.work_item_targets WHERE work_item_id = ${merged.at(-1)!.id}
        AND repository_id = ${otherRepository!.id}`);

      // A completed delivery is enough even while its latest change has not merged.
      await execute(
        sql`UPDATE app.changes SET status = 'open' WHERE organization_id = ${tenant.organizationId}`,
      );
      await execute(
        sql`UPDATE app.deliveries SET status = 'completed' WHERE organization_id = ${tenant.organizationId}`,
      );
      expect(await readBoardPage([tenant.organizationId])).toMatchObject({
        items: page.items.map(({ targets: _targets, ...item }) => item),
      });
      // Cancellation wins over successful delivery; archiving does too.
      await updateWorkItem(merged.at(-1)!.id, { status: 'cancelled' });
      await updateWorkItem(merged.at(-2)!.id, { archived: true });
      const visible = await readBoardPage([tenant.organizationId]);
      expect(visible.items.filter((item) => item.column === 'done')).toHaveLength(24);
      expect(
        visible.items.some((item) => [merged.at(-1)!.id, merged.at(-2)!.id].includes(item.id)),
      ).toBe(false);
    }));

  it('archives and restores through the authenticated API without changing completion or execution status', () =>
    rollbackAfter(async () => {
      const tenant = await createTenant();
      const stranger = await createTenant();
      const handle = createEffectApiHandler(apiDependencies([], async () => tenant.user));
      const foreign = createEffectApiHandler(apiDependencies([], async () => stranger.user));
      for (const status of ['in_progress', 'completed'] as const) {
        const [item] = await insertItems(tenant.organizationId, 1, status);
        await updateWorkItem(item!.id, { status });
        const before = (await getWorkItem(item!.id))!;
        const patch = (archived: boolean) =>
          new Request(`https://app.test/api/work-items/${item!.id}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ archived }),
          });
        expect((await foreign(patch(true))).status).toBe(404);
        expect((await getWorkItem(item!.id))!.archived_at).toBeNull();
        const response = await handle(patch(true));
        expect(response.status).toBe(200);
        const archived = (await getWorkItem(item!.id))!;
        expect(archived.archived_at).not.toBeNull();
        expect(Number.isFinite(new Date(archived.archived_at!).getTime())).toBe(true);
        expect(await response.json()).toMatchObject({
          id: item!.id,
          archivedAt: archived.archived_at,
          status,
        });
        expect(
          (await readBoardPage([tenant.organizationId])).items.some((card) => card.id === item!.id),
        ).toBe(false);
        expect(await getWorkItem(item!.id)).toMatchObject({
          status,
          completed_at: before.completed_at,
          archived_at: archived.archived_at,
        });
        // A retried archive and unrelated edits must preserve the original archive time.
        const originalArchiveTime = '2026-01-02T03:04:05.000Z';
        await execute(
          sql`UPDATE app.work_items SET archived_at = ${originalArchiveTime} WHERE id = ${item!.id}`,
        );
        const persistedArchiveTime = (await getWorkItem(item!.id))!.archived_at;
        const retried = await handle(patch(true));
        expect(retried.status).toBe(200);
        expect(await retried.json()).toMatchObject({ archivedAt: persistedArchiveTime });
        await updateWorkItem(item!.id, { title: 'Edited while archived' });
        expect(new Date((await getWorkItem(item!.id))!.archived_at!).toISOString()).toBe(
          originalArchiveTime,
        );
        expect((await handle(patch(false))).status).toBe(200);
        expect(
          (await readBoardPage([tenant.organizationId])).items.find((card) => card.id === item!.id),
        ).toMatchObject({ column: status === 'completed' ? 'done' : 'in_progress' });
        expect(await getWorkItem(item!.id)).toMatchObject({
          status,
          completed_at: before.completed_at,
          archived_at: null,
        });
      }
    }));

  it('keeps SQL round trips and response size constant when execution history grows, while preserving card links', () =>
    rollbackAfter(async () => {
      const tenant = await createTenant();
      const item = await createWorkItem({
        organizationId: tenant.organizationId,
        origin: 'idea',
        title: 'Review this task',
        description: 'Complete requirements',
        repositoryIds: [tenant.repositoryId],
      });
      await updateWorkItem(item.id, { status: 'approved' });
      const [delivery] = await createDeliveries(item);
      await upsertChange({
        organizationId: tenant.organizationId,
        repositoryId: tenant.repositoryId,
        deliveryId: delivery!.id,
        providerIntegrationId: tenant.integrationId,
        providerKey: 'pull_request:42',
        number: 42,
        title: item.title,
        sourceRef: 'turbodiff/test',
        targetRef: 'main',
        origin: 'factory',
      });
      let reads = 0;
      const read = <Row extends QueryResultRow>(statement: SQL) => {
        reads++;
        return queryRows<Row>(statement);
      };
      const before = await readBoardPage([tenant.organizationId], {}, read);
      expect(reads).toBe(2);
      expect(before.items[0]).toMatchObject({
        id: item.id,
        title: item.title,
        status: 'approved',
        notes: null,
        targets: [
          {
            repositoryId: tenant.repositoryId,
            deliveryId: delivery!.id,
            changeNumber: 42,
            changeStatus: 'open',
            provider: 'github',
          },
        ],
      });
      // Metadata deliberately has no R2 body: board reads must not depend on loading this plan.
      const artifact = await recordArtifact({
        organizationId: tenant.organizationId,
        kind: 'plan',
        schemaVersion: 1,
        storageKey: `tests/board/${crypto.randomUUID()}`,
        contentType: 'application/json',
        contentHash: 'a'.repeat(64),
        sizeBytes: 200_000,
      });
      await execute(
        sql`UPDATE app.work_items SET approved_plan_artifact_id = ${artifact.id} WHERE id = ${item.id}`,
      );
      for (let i = 0; i < 12; i++) {
        const run = await createFactoryRunWithStage(
          {
            organizationId: tenant.organizationId,
            flowKey: 'work_item',
            flowVersion: 1,
            workItemId: item.id,
            trigger: 'test',
            idempotencyKey: crypto.randomUUID(),
          },
          { stageKey: 'plan', idempotencyKey: crypto.randomUUID() },
        );
        await recordLifecycleEvent({
          organizationId: tenant.organizationId,
          factoryRunId: run.factoryRun.id,
          stageRunId: run.stageRun.id,
          kind: 'test',
          payload: { evidence: 'History detail '.repeat(2_000) },
        });
      }
      reads = 0;
      expect(await readBoardPage([tenant.organizationId], {}, read)).toEqual(before);
      expect(reads).toBe(2);
      let authenticated = 0;
      const handle = createEffectApiHandler(
        apiDependencies([], async () => {
          authenticated++;
          return tenant.user;
        }),
      );
      const response = await handle(new Request('https://app.test/api/board-view'));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(JSON.parse(JSON.stringify(before)));
      expect(authenticated).toBe(1);
    }));

  it('validates cursor inputs and returns complete todo requirements through the signed-in contract', () =>
    rollbackAfter(async () => {
      const tenant = await createTenant();
      const description = 'Keep these original requirements. '.repeat(80);
      const item = await createWorkItem({
        organizationId: tenant.organizationId,
        origin: 'idea',
        title: 'Todo',
        description,
        repositoryIds: [tenant.repositoryId],
      });
      const handle = createEffectApiHandler(apiDependencies([], async () => tenant.user));
      const first = await handle(new Request('https://app.test/api/board-view'));
      expect(await first.json()).toMatchObject({
        items: [
          { id: item.id, notes: description, targets: [{ repositoryId: tenant.repositoryId }] },
        ],
      });
      for (const cursor of [
        '0',
        '-1',
        'abc',
        '1.5',
        '2026-99-01T00:00:00.000000Z|1',
        '2026-02-31T00:00:00.000000Z|1',
        '2026-01-01T00:00:00.000000Z|0',
      ]) {
        const invalid = await handle(
          new Request(`https://app.test/api/board-view?activeBefore=${cursor}`),
        );
        expect(invalid.status).toBe(400);
      }
      expect(
        (
          await handle(
            new Request(
              `https://app.test/api/board-view?activeBefore=${encodeURIComponent(`2026-01-01T00:00:00.000000Z|${item.id}`)}`,
            ),
          )
        ).status,
      ).toBe(200);
    }));
});
