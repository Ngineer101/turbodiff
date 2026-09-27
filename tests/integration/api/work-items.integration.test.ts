import { sql } from 'drizzle-orm';
import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vite-plus/test';
import { claimAgentRun, completeAgentRun, createAgentRun } from '../../../src/data/execution.ts';
import { recordArtifact } from '../../../src/data/artifacts.ts';
import { getWorkItem } from '../../../src/data/work.ts';
import { queryOne } from '../../../src/data/postgres.ts';
import type { RunFactoryMessage } from '../../../src/application/factory/message.ts';
import {
  WorkItemService,
  WorkItemServiceLive,
} from '../../../src/api/server/work-items/service.ts';
import { createTenant, recordingApiDependencies, rollbackAfter } from './support.ts';

const workItemLayer = (messages: RunFactoryMessage[]) =>
  WorkItemServiceLive.pipe(Layer.provide(recordingApiDependencies(messages)));

describe('WorkItemService with PostgreSQL', () => {
  it('persists the work-item to factory-run to stage-run chain and queues durable ids', () =>
    rollbackAfter(async () => {
      const tenant = await createTenant();
      const messages: RunFactoryMessage[] = [];
      const layer = workItemLayer(messages);
      const created = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* WorkItemService;
          return yield* service.create(tenant.user, {
            organizationId: tenant.organizationId,
            repositoryIds: [tenant.repositoryId],
            title: '  Build the primitive path  ',
            description: '  Exercise the durable lifecycle.  ',
          });
        }).pipe(Effect.provide(layer)),
      );

      expect(created).toMatchObject({
        organizationId: tenant.organizationId,
        title: 'Build the primitive path',
        description: 'Exercise the durable lifecycle.',
        status: 'open',
        targets: [{ repositoryId: tenant.repositoryId, position: 0 }],
      });

      const started = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* WorkItemService;
          return yield* service.startRun(tenant.user, created.id, 'planning');
        }).pipe(Effect.provide(layer)),
      );
      const persisted = await queryOne<{
        organization_id: string;
        work_item_status: string;
        flow_key: string;
        flow_version: number;
        factory_status: string;
        stage_key: string;
        stage_status: string;
      }>(sql`
        SELECT factory.organization_id, work_item.status AS work_item_status,
          factory.flow_key, factory.flow_version, factory.status AS factory_status,
          stage.stage_key, stage.status AS stage_status
        FROM app.factory_runs factory
        JOIN app.work_items work_item ON work_item.id = factory.work_item_id
          AND work_item.organization_id = factory.organization_id
        JOIN app.stage_runs stage ON stage.factory_run_id = factory.id
          AND stage.organization_id = factory.organization_id
        WHERE factory.id = ${started.factoryRunId} AND stage.id = ${started.stageRunId}
      `);

      expect(persisted).toEqual({
        organization_id: tenant.organizationId,
        work_item_status: 'planning',
        flow_key: 'work_item',
        flow_version: 1,
        factory_status: 'queued',
        stage_key: 'plan',
        stage_status: 'queued',
      });
      expect(messages).toEqual([
        {
          kind: 'run_factory',
          factoryRunId: started.factoryRunId,
          stageRunId: started.stageRunId,
        },
      ]);
    }));

  it('keeps targetless todos in the backlog and requires a repository only when starting', () =>
    rollbackAfter(async () => {
      const tenant = await createTenant();
      const messages: RunFactoryMessage[] = [];
      const layer = workItemLayer(messages);
      const created = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* WorkItemService;
          return yield* service.create(tenant.user, {
            organizationId: tenant.organizationId,
            repositoryIds: [],
            title: 'Choose the repository later',
            description: 'Keep this todo on the board until it is ready to start',
          });
        }).pipe(Effect.provide(layer)),
      );

      expect(created).toMatchObject({
        organizationId: tenant.organizationId,
        status: 'open',
        targets: [],
      });
      const rejectedStart = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* WorkItemService;
          return yield* service.startRun(tenant.user, created.id, 'planning');
        }).pipe(Effect.provide(layer), Effect.either),
      );
      expect(rejectedStart).toMatchObject({
        _tag: 'Left',
        left: {
          _tag: 'BadRequest',
          detail: 'Choose between one and three repositories before starting',
        },
      });
      expect(await getWorkItem(created.id)).toMatchObject({ status: 'open' });
      expect(messages).toEqual([]);

      const started = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* WorkItemService;
          yield* service.update(tenant.user, created.id, {
            repositoryIds: [tenant.repositoryId],
          });
          return yield* service.startRun(tenant.user, created.id, 'planning');
        }).pipe(Effect.provide(layer)),
      );
      expect(started.status).toBe('queued');
      expect(messages).toEqual([
        {
          kind: 'run_factory',
          factoryRunId: started.factoryRunId,
          stageRunId: started.stageRunId,
        },
      ]);
    }));

  it('rejects cross-organization targets and non-admin writes without partial rows', () =>
    rollbackAfter(async () => {
      const owner = await createTenant('owner');
      const other = await createTenant('owner');
      const member = await createTenant('member');
      const messages: RunFactoryMessage[] = [];
      const layer = workItemLayer(messages);

      const crossTenant = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* WorkItemService;
          return yield* service.create(owner.user, {
            organizationId: owner.organizationId,
            repositoryIds: [other.repositoryId],
            title: 'Cross tenant',
            description: 'Must not be written',
          });
        }).pipe(Effect.provide(layer), Effect.either),
      );
      const insufficientRole = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* WorkItemService;
          return yield* service.create(member.user, {
            organizationId: member.organizationId,
            repositoryIds: [member.repositoryId],
            title: 'Member write',
            description: 'Must not be written',
          });
        }).pipe(Effect.provide(layer), Effect.either),
      );

      expect(crossTenant._tag).toBe('Left');
      if (crossTenant._tag === 'Left') expect(crossTenant.left._tag).toBe('BadRequest');
      expect(insufficientRole._tag).toBe('Left');
      if (insufficientRole._tag === 'Left') expect(insufficientRole.left._tag).toBe('Forbidden');
      const count = await queryOne<{ count: number }>(sql`
        SELECT COUNT(*)::int AS count FROM app.work_items
        WHERE organization_id IN (${owner.organizationId}, ${member.organizationId})
      `);
      expect(count?.count).toBe(0);
      expect(messages).toEqual([]);
    }));

  it('accepts only organization-owned attachment artifacts and records durable ids', () =>
    rollbackAfter(async () => {
      const tenant = await createTenant();
      const other = await createTenant();
      const messages: RunFactoryMessage[] = [];
      const layer = workItemLayer(messages);
      const create = (title: string) =>
        Effect.runPromise(
          Effect.gen(function* () {
            const service = yield* WorkItemService;
            return yield* service.create(tenant.user, {
              organizationId: tenant.organizationId,
              repositoryIds: [tenant.repositoryId],
              title,
              description: 'Use immutable attachment artifacts',
            });
          }).pipe(Effect.provide(layer)),
        );
      const [workItem, rejectedWorkItem] = await Promise.all([
        create('Attachment provenance'),
        create('Foreign attachment'),
      ]);
      const ownedAttachment = await recordArtifact({
        organizationId: tenant.organizationId,
        kind: 'work_item_attachment',
        schemaVersion: 1,
        storageKey: `tests/${crypto.randomUUID()}/design.pdf`,
        contentType: 'application/pdf',
        contentHash: crypto.randomUUID(),
        sizeBytes: 10,
      });
      const foreignAttachment = await recordArtifact({
        organizationId: other.organizationId,
        kind: 'work_item_attachment',
        schemaVersion: 1,
        storageKey: `tests/${crypto.randomUUID()}/foreign.pdf`,
        contentType: 'application/pdf',
        contentHash: crypto.randomUUID(),
        sizeBytes: 10,
      });

      const started = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* WorkItemService;
          return yield* service.startRun(tenant.user, workItem.id, 'planning', undefined, [
            { artifactId: ownedAttachment.id, name: '  design.pdf  ' },
          ]);
        }).pipe(Effect.provide(layer)),
      );
      const loaded = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* WorkItemService;
          return yield* service.get(tenant.user, workItem.id);
        }).pipe(Effect.provide(layer)),
      );
      expect(loaded.attachments).toEqual([{ artifactId: ownedAttachment.id, name: 'design.pdf' }]);
      const event = await queryOne<{ payload: { attachments: unknown[] } }>(sql`
        SELECT payload FROM app.lifecycle_events
        WHERE factory_run_id = ${started.factoryRunId} AND kind = 'factory_run_requested'
      `);
      expect(event?.payload).toEqual({
        attachments: [{ artifactId: ownedAttachment.id, name: 'design.pdf' }],
      });

      const denied = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* WorkItemService;
          return yield* service.startRun(tenant.user, rejectedWorkItem.id, 'planning', undefined, [
            { artifactId: foreignAttachment.id, name: 'foreign.pdf' },
          ]);
        }).pipe(Effect.provide(layer), Effect.either),
      );
      expect(denied._tag).toBe('Left');
      if (denied._tag === 'Left') expect(denied.left._tag).toBe('NotFound');
      const rejectedRuns = await queryOne<{ count: number }>(sql`
        SELECT COUNT(*)::int AS count FROM app.factory_runs
        WHERE work_item_id = ${rejectedWorkItem.id}
      `);
      expect(rejectedRuns?.count).toBe(0);
      expect(messages).toEqual([
        {
          kind: 'run_factory',
          factoryRunId: started.factoryRunId,
          stageRunId: started.stageRunId,
        },
      ]);
    }));

  it('approves only a plan artifact produced by a successful agent run for that work item', () =>
    rollbackAfter(async () => {
      const tenant = await createTenant();
      const messages: RunFactoryMessage[] = [];
      const layer = workItemLayer(messages);
      const created = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* WorkItemService;
          return yield* service.create(tenant.user, {
            organizationId: tenant.organizationId,
            repositoryIds: [tenant.repositoryId],
            title: 'Provenance',
            description: 'Approve only a produced plan',
          });
        }).pipe(Effect.provide(layer)),
      );
      const unattachedPlan = await recordArtifact({
        organizationId: tenant.organizationId,
        kind: 'plan',
        schemaVersion: 1,
        storageKey: `tests/${crypto.randomUUID()}/unattached-plan.json`,
        contentType: 'application/json',
        contentHash: crypto.randomUUID(),
        sizeBytes: 10,
      });
      const denied = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* WorkItemService;
          return yield* service.approvePlan(tenant.user, created.id, unattachedPlan.id);
        }).pipe(Effect.provide(layer), Effect.either),
      );
      expect(denied._tag).toBe('Left');
      if (denied._tag === 'Left') expect(denied.left._tag).toBe('Conflict');
      expect(await getWorkItem(created.id)).toMatchObject({
        status: 'open',
        approved_plan_artifact_id: null,
      });

      const started = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* WorkItemService;
          return yield* service.startRun(tenant.user, created.id, 'planning');
        }).pipe(Effect.provide(layer)),
      );
      const input = await recordArtifact({
        organizationId: tenant.organizationId,
        kind: 'work_item',
        schemaVersion: 1,
        storageKey: `tests/${crypto.randomUUID()}/input.json`,
        contentType: 'application/json',
        contentHash: crypto.randomUUID(),
        sizeBytes: 10,
      });
      const producedPlan = await recordArtifact({
        organizationId: tenant.organizationId,
        kind: 'plan',
        schemaVersion: 1,
        storageKey: `tests/${crypto.randomUUID()}/plan.json`,
        contentType: 'application/json',
        contentHash: crypto.randomUUID(),
        sizeBytes: 10,
      });
      const model = await queryOne<{ id: number }>(sql`
        SELECT id FROM app.models WHERE enabled ORDER BY id LIMIT 1
      `);
      if (!model) throw new Error('baseline model fixture is missing');
      const agentRun = await createAgentRun({
        organizationId: tenant.organizationId,
        stageRunId: started.stageRunId,
        agentId: tenant.agentId,
        modelId: model.id,
        inputArtifactId: input.id,
        idempotencyKey: `tests:${crypto.randomUUID()}`,
      });
      expect(await claimAgentRun(agentRun.id)).toBe(true);
      await completeAgentRun({
        id: agentRun.id,
        outputArtifactId: producedPlan.id,
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
      await queryOne(sql`
        UPDATE app.stage_runs SET status = 'waiting'
        WHERE id = ${started.stageRunId}
        RETURNING id
      `);
      await queryOne(sql`
        UPDATE app.factory_runs SET status = 'waiting'
        WHERE id = ${started.factoryRunId}
        RETURNING id
      `);

      await expect(
        Effect.runPromise(
          Effect.gen(function* () {
            const service = yield* WorkItemService;
            return yield* service.approvePlan(tenant.user, created.id, producedPlan.id);
          }).pipe(Effect.provide(layer)),
        ),
      ).resolves.toEqual({ artifactId: producedPlan.id, status: 'approved' });
      expect(await getWorkItem(created.id)).toMatchObject({
        status: 'approved',
        approved_plan_artifact_id: producedPlan.id,
      });
      const resumed = await queryOne<{ status: string; stage_key: string }>(sql`
        SELECT factory.status, stage.stage_key
        FROM app.factory_runs factory
        JOIN app.stage_runs stage ON stage.factory_run_id = factory.id
        WHERE factory.id = ${started.factoryRunId} AND stage.stage_key = 'dispatch'
      `);
      expect(resumed).toEqual({ status: 'queued', stage_key: 'dispatch' });
      expect(messages.at(-1)).toEqual({
        kind: 'run_factory',
        factoryRunId: started.factoryRunId,
        stageRunId: expect.any(Number),
      });
    }));
});
