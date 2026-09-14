import { sql } from 'drizzle-orm';
import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vite-plus/test';
import {
  claimAgentRun,
  completeAgentRun,
  createAgentRun,
  getWorkItem,
  recordArtifact,
} from '../../../../data/db.ts';
import { queryOne } from '../../../../data/database.ts';
import type { RunFactoryMessage } from '../../../../shared/factory-messages.ts';
import { WorkItemService, WorkItemServiceLive } from '../../work-items/service.ts';
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
        flow_key: 'planning',
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
      if (denied._tag === 'Left') expect(denied.left._tag).toBe('NotFound');
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
        costUsd: 0,
      });

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
    }));
});
