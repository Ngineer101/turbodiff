import { sql } from 'drizzle-orm';
import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vite-plus/test';
import { queryOne } from '../../../../data/database.ts';
import type { RunFactoryMessage } from '../../../../shared/factory-messages.ts';
import { AutomationService, AutomationServiceLive } from '../../automations/service.ts';
import { createTenant, recordingApiDependencies, rollbackAfter } from './support.ts';

const automationLayer = (messages: RunFactoryMessage[]) =>
  AutomationServiceLive.pipe(Layer.provide(recordingApiDependencies(messages)));

describe('AutomationService with PostgreSQL', () => {
  it('enforces organization-scoped bindings and triggers the complete primitive chain', () =>
    rollbackAfter(async () => {
      const tenant = await createTenant();
      const other = await createTenant();
      const messages: RunFactoryMessage[] = [];
      const layer = automationLayer(messages);
      const invalid = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* AutomationService;
          return yield* service.create(tenant.user, {
            organizationId: tenant.organizationId,
            agentId: tenant.agentId,
            repositoryId: tenant.repositoryId,
            name: 'Foreign binding',
            schedule: 'hourly',
            inputTemplate: { title: 'Invalid', description: 'Must not be written' },
            integrationIds: [other.integrationId],
          });
        }).pipe(Effect.provide(layer), Effect.either),
      );
      expect(invalid._tag).toBe('Left');
      if (invalid._tag === 'Left') expect(invalid.left._tag).toBe('BadRequest');

      const created = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* AutomationService;
          return yield* service.create(tenant.user, {
            organizationId: tenant.organizationId,
            agentId: tenant.agentId,
            repositoryId: tenant.repositoryId,
            name: 'Hourly maintenance',
            schedule: 'hourly',
            inputTemplate: {
              title: 'Scheduled maintenance',
              description: 'Keep dependencies current',
            },
            integrationIds: [tenant.integrationId],
          });
        }).pipe(Effect.provide(layer)),
      );
      expect(created).toMatchObject({
        organizationId: tenant.organizationId,
        agentId: tenant.agentId,
        repositoryId: tenant.repositoryId,
        integrationIds: [tenant.integrationId],
        enabled: true,
      });

      const started = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* AutomationService;
          return yield* service.run(tenant.user, created.id);
        }).pipe(Effect.provide(layer)),
      );
      const persisted = await queryOne<{
        automation_id: number;
        work_item_id: number;
        origin: string;
        title: string;
        repository_id: number;
        flow_key: string;
        stage_key: string;
      }>(sql`
        SELECT factory.automation_id, factory.work_item_id, work_item.origin, work_item.title,
          target.repository_id, factory.flow_key, stage.stage_key
        FROM app.factory_runs factory
        JOIN app.work_items work_item ON work_item.id = factory.work_item_id
          AND work_item.organization_id = factory.organization_id
        JOIN app.work_item_targets target ON target.work_item_id = work_item.id
          AND target.organization_id = work_item.organization_id
        JOIN app.stage_runs stage ON stage.factory_run_id = factory.id
          AND stage.organization_id = factory.organization_id
        WHERE factory.id = ${started.factoryRunId}
      `);
      expect(persisted).toEqual({
        automation_id: created.id,
        work_item_id: expect.any(Number),
        origin: 'automation',
        title: 'Scheduled maintenance',
        repository_id: tenant.repositoryId,
        flow_key: 'automation',
        stage_key: 'invoke',
      });
      expect(messages).toEqual([
        {
          kind: 'run_factory',
          factoryRunId: started.factoryRunId,
          stageRunId: expect.any(Number),
        },
      ]);

      const counts = await queryOne<{ automations: number; invalid_bindings: number }>(sql`
        SELECT
          COUNT(*)::int AS automations,
          COUNT(*) FILTER (
            WHERE link.integration_id = ${other.integrationId}
          )::int AS invalid_bindings
        FROM app.automations automation
        LEFT JOIN app.automation_integrations link ON link.automation_id = automation.id
        WHERE automation.organization_id = ${tenant.organizationId}
      `);
      expect(counts).toEqual({ automations: 1, invalid_bindings: 0 });
    }));
});
