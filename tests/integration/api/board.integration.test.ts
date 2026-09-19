import { sql, type SQL } from 'drizzle-orm';
import type { QueryResultRow } from 'pg';
import { describe, expect, it } from 'vite-plus/test';
import { createEffectApiHandler } from '../../../src/api/server/handler.ts';
import { readBoardPage } from '../../../src/data/board.ts';
import { recordArtifact } from '../../../src/data/artifacts.ts';
import { upsertChange } from '../../../src/data/changes.ts';
import { createFactoryRunWithStage, recordLifecycleEvent } from '../../../src/data/execution.ts';
import { execute, queryRows } from '../../../src/data/postgres.ts';
import { createWorkItem, createDeliveries, updateWorkItem } from '../../../src/data/work.ts';
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
      await insertItems(stranger.organizationId, 80, 'open');
      await insertItems(stranger.organizationId, 80, 'completed');
      const page = await readBoardPage([owner.organizationId]);
      expect(page.items.filter((item) => item.status === 'open')).toHaveLength(50);
      expect(page.items.filter((item) => item.status === 'completed')).toHaveLength(25);
      expect(page.items.every((item) => item.organizationId === owner.organizationId)).toBe(true);
      expect(page.items.some((item) => item.status === 'cancelled')).toBe(false);
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
      for (const cursor of ['0', '-1', 'abc', '1.5']) {
        const invalid = await handle(
          new Request(`https://app.test/api/board-view?activeBefore=${cursor}`),
        );
        expect(invalid.status).toBe(400);
      }
      expect(
        (await handle(new Request(`https://app.test/api/board-view?activeBefore=${item.id}`)))
          .status,
      ).toBe(200);
    }));
});
