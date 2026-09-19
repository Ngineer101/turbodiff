import { sql } from 'drizzle-orm';
import { Effect, Layer } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { createEffectApiHandler } from '../../../src/api/server/handler.ts';
import { ArtifactService, ArtifactServiceLive } from '../../../src/api/server/artifacts/service.ts';
import { ChangeService, ChangeServiceLive } from '../../../src/api/server/changes/service.ts';
import {
  DeliveryService,
  DeliveryServiceLive,
} from '../../../src/api/server/deliveries/service.ts';
import {
  RepositoryService,
  RepositoryServiceLive,
} from '../../../src/api/server/repositories/service.ts';
import { persistJsonArtifact } from '../../../src/application/artifacts.ts';
import type { RunFactoryMessage } from '../../../src/application/factory/message.ts';
import { changeRevisionArtifactSchema } from '../../../src/artifacts/change.ts';
import { acceptanceContractArtifactSchema } from '../../../src/artifacts/plan.ts';
import { createDeliveryMessage } from '../../../src/data/deliveries.ts';
import { createChangeRevision, upsertChange } from '../../../src/data/changes.ts';
import { queryOne } from '../../../src/data/postgres.ts';
import { isJsonArray, isJsonObject } from '../../../src/shared/json.ts';
import { createDeliveries, createWorkItem } from '../../../src/data/work.ts';
import {
  apiDependencies,
  createTenant,
  recordingApiDependencies,
  rollbackAfter,
  type TenantFixture,
} from './support.ts';

const serviceLayer = <R, E, A>(layer: Layer.Layer<R, E, A>, messages: RunFactoryMessage[]) =>
  layer.pipe(Layer.provide(recordingApiDependencies(messages)));

async function deliveryFixture(tenant: TenantFixture) {
  const workItem = await createWorkItem({
    organizationId: tenant.organizationId,
    origin: 'idea',
    title: 'Primitive graph',
    description: 'Exercise the canonical backend graph',
    createdByUserId: tenant.userId,
    repositoryIds: [tenant.repositoryId],
  });
  const delivery = (await createDeliveries(workItem))[0];
  if (!delivery) throw new Error('delivery fixture was not created');
  return { workItem, delivery };
}

describe('primitive services with PostgreSQL', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('persists and reads the delivery, artifact, change, revision, and review-run graph', () =>
    rollbackAfter(async () => {
      const tenant = await createTenant();
      const messages: RunFactoryMessage[] = [];
      const { delivery } = await deliveryFixture(tenant);
      const acceptance = await persistJsonArtifact({
        organizationId: tenant.organizationId,
        kind: 'acceptance_contract',
        storageKey: `tests/${crypto.randomUUID()}/acceptance.json`,
        schema: acceptanceContractArtifactSchema,
        value: { kind: 'acceptance-contract', planArtifactId: 1, criteria: ['It works'] },
      });
      const deliveryLayer = serviceLayer(DeliveryServiceLive, messages);

      const accepted = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* DeliveryService;
          const contract = yield* service.replaceAcceptanceContract(
            tenant.user,
            delivery.id,
            acceptance.id,
            'active',
          );
          const message = yield* Effect.promise(() =>
            createDeliveryMessage({
              delivery,
              authorUserId: tenant.userId,
              role: 'user',
              body: 'Preserve this context.',
            }),
          );
          const run = yield* service.startRun(tenant.user, delivery.id);
          const loaded = yield* service.get(tenant.user, delivery.id);
          return { contract, message, run, loaded };
        }).pipe(Effect.provide(deliveryLayer)),
      );
      expect(accepted.contract).toMatchObject({ version: 1, status: 'active' });
      expect(accepted.message).toMatchObject({ body: 'Preserve this context.', role: 'user' });
      expect(accepted.loaded).toMatchObject({
        id: delivery.id,
        organizationId: tenant.organizationId,
        status: 'active',
        acceptanceContract: { artifactId: acceptance.id, status: 'active' },
      });

      const change = await upsertChange({
        organizationId: tenant.organizationId,
        repositoryId: tenant.repositoryId,
        deliveryId: delivery.id,
        providerIntegrationId: tenant.integrationId,
        providerKey: `pull-request:${crypto.randomUUID()}`,
        number: 17,
        title: 'Primitive change',
        sourceRef: 'turbodiff/primitive-change',
        targetRef: 'main',
        origin: 'factory',
      });
      const revisionArtifact = await persistJsonArtifact({
        organizationId: tenant.organizationId,
        kind: 'change_revision',
        storageKey: `tests/${crypto.randomUUID()}/revision.json`,
        schema: changeRevisionArtifactSchema,
        value: {
          kind: 'change-revision',
          title: 'Primitive change',
          description: 'One immutable revision',
          base: 'main',
          head: 'turbodiff/primitive-change',
          baseSha: 'a'.repeat(40),
          headSha: 'b'.repeat(40),
          files: [{ path: 'src/index.ts', reviewable: true, omittedReason: null }],
          patch: 'diff --git a/src/index.ts b/src/index.ts',
        },
      });
      const revision = await createChangeRevision({
        change,
        baseSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
        artifactId: revisionArtifact.id,
      });
      const changeLayer = serviceLayer(ChangeServiceLive, messages);
      const review = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* ChangeService;
          return yield* service.createReviewRun(tenant.user, change.id);
        }).pipe(Effect.provide(changeLayer)),
      );
      const artifact = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* ArtifactService;
          return yield* service.get(tenant.user, revisionArtifact.id);
        }).pipe(Effect.provide(ArtifactServiceLive)),
      );
      const persisted = await queryOne<{
        change_id: number;
        revision_id: number;
        artifact_id: number;
        flow_key: string;
        stage_key: string;
      }>(sql`
        SELECT change.id AS change_id, revision.id AS revision_id,
          revision.artifact_id, factory.flow_key, stage.stage_key
        FROM app.changes change
        JOIN app.change_revisions revision ON revision.change_id = change.id
          AND revision.organization_id = change.organization_id
        JOIN app.factory_runs factory ON factory.change_id = change.id
          AND factory.organization_id = change.organization_id
        JOIN app.stage_runs stage ON stage.factory_run_id = factory.id
          AND stage.organization_id = factory.organization_id
        WHERE factory.id = ${review.factoryRunId}
      `);
      expect(persisted).toEqual({
        change_id: change.id,
        revision_id: revision.id,
        artifact_id: revisionArtifact.id,
        flow_key: 'review',
        stage_key: 'review',
      });
      expect(artifact).toMatchObject({
        id: revisionArtifact.id,
        organizationId: tenant.organizationId,
        kind: 'change_revision',
        value: { kind: 'change-revision', headSha: 'b'.repeat(40) },
      });
      expect(messages).toEqual([
        {
          kind: 'run_factory',
          factoryRunId: accepted.run.factoryRunId,
          stageRunId: accepted.run.stageRunId,
        },
        {
          kind: 'run_factory',
          factoryRunId: review.factoryRunId,
          stageRunId: review.stageRunId,
        },
      ]);
    }));

  it('keeps repository, delivery, change, and artifact access behind the organization wall', () =>
    rollbackAfter(async () => {
      const tenant = await createTenant();
      const other = await createTenant();
      const messages: RunFactoryMessage[] = [];
      const { delivery } = await deliveryFixture(other);
      const artifact = await persistJsonArtifact({
        organizationId: other.organizationId,
        kind: 'test',
        storageKey: `tests/${crypto.randomUUID()}/foreign.json`,
        schema: acceptanceContractArtifactSchema,
        value: { kind: 'acceptance-contract', planArtifactId: 1, criteria: [] },
      });
      const change = await upsertChange({
        organizationId: other.organizationId,
        repositoryId: other.repositoryId,
        deliveryId: delivery.id,
        providerIntegrationId: other.integrationId,
        providerKey: `pull-request:${crypto.randomUUID()}`,
        number: 23,
        title: 'Foreign change',
        sourceRef: 'foreign',
        targetRef: 'main',
        origin: 'human',
      });
      const deliveryResult = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* DeliveryService;
          return yield* service.get(tenant.user, delivery.id);
        }).pipe(Effect.provide(serviceLayer(DeliveryServiceLive, messages)), Effect.either),
      );
      const changeResult = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* ChangeService;
          return yield* service.get(tenant.user, change.id);
        }).pipe(Effect.provide(serviceLayer(ChangeServiceLive, messages)), Effect.either),
      );
      const artifactResult = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* ArtifactService;
          return yield* service.get(tenant.user, artifact.id);
        }).pipe(Effect.provide(ArtifactServiceLive), Effect.either),
      );
      const repositories = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* RepositoryService;
          return yield* service.list(tenant.user);
        }).pipe(Effect.provide(RepositoryServiceLive)),
      );
      const foreignBinding = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* RepositoryService;
          return yield* service.setAgentEnabled(
            tenant.user,
            tenant.repositoryId,
            other.agentId,
            true,
          );
        }).pipe(Effect.provide(RepositoryServiceLive), Effect.either),
      );

      for (const result of [deliveryResult, changeResult, artifactResult, foreignBinding]) {
        expect(result._tag).toBe('Left');
        if (result._tag === 'Left') expect(result.left._tag).toBe('NotFound');
      }
      expect(repositories.items.map((repository) => repository.id)).toEqual([tenant.repositoryId]);
      expect(repositories.items[0]?.agents.map((agent) => agent.id)).not.toContain(other.agentId);
      expect(messages).toEqual([]);
    }));

  it('rejects malformed requests at the Effect HTTP contract before service execution', () =>
    rollbackAfter(async () => {
      const tenant = await createTenant();
      const messages: RunFactoryMessage[] = [];
      const handler = createEffectApiHandler(apiDependencies(messages, async () => tenant.user));
      const response = await handler(
        new Request('http://localhost/api/work-items', {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: 'http://localhost' },
          body: JSON.stringify({
            organizationId: tenant.organizationId,
            repositoryIds: ['not-an-id'],
            title: 'Invalid',
            description: 'The contract must reject this',
          }),
        }),
      );
      const body: unknown = await response.json();
      expect(response.status).toBe(400);
      expect(isJsonObject(body) ? body._tag : null).toBe('HttpApiDecodeError');
      const issues = isJsonObject(body) && isJsonArray(body.issues) ? body.issues : [];
      expect(
        issues.some(
          (issue) =>
            isJsonObject(issue) && isJsonArray(issue.path) && issue.path.includes('repositoryIds'),
        ),
      ).toBe(true);
      expect(messages).toEqual([]);
    }));

  it('tests an organization-owned integration through the Effect HTTP resource', () =>
    rollbackAfter(async () => {
      const tenant = await createTenant();
      const integration = await queryOne<{ id: number }>(sql`
        INSERT INTO app.integrations (organization_id, kind, provider, name, config)
        VALUES (
          ${tenant.organizationId}, 'api', 'http', 'status-api',
          ${JSON.stringify({ url: 'https://status.example.test', authType: 'none' })}::jsonb
        )
        RETURNING id
      `);
      if (!integration) throw new Error('integration fixture insert returned no row');
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(null, { status: 204, statusText: 'No Content' })),
      );
      const handler = createEffectApiHandler(apiDependencies([], async () => tenant.user));
      const response = await handler(
        new Request(`http://localhost/api/integrations/${integration.id}/tests`, {
          method: 'POST',
          headers: { origin: 'http://localhost' },
        }),
      );
      await expect(response.json()).resolves.toEqual({
        ok: true,
        detail: 'HTTP 204 No Content',
        tools: [],
        reauthorizationRequired: false,
      });
      expect(response.status).toBe(200);
      expect(fetch).toHaveBeenCalledWith(
        'https://status.example.test',
        expect.objectContaining({ method: 'GET' }),
      );
    }));
});
