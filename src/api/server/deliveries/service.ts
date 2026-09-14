import { Context, Effect, Layer } from 'effect';
import {
  activeAcceptanceContract,
  createAcceptanceContract,
  createDeliveryMessage,
  createFactoryRunWithStage,
  getArtifact,
  getDelivery,
  getDeliveryRepository,
  listChangesForDelivery,
  listDeliveryMessages,
  listFactoryRuns,
  updateDeliveryStatus,
  type AcceptanceContractRow,
} from '../../../data/db.ts';
import { DELIVERY_FLOW } from '../../../application/factory/flows.ts';
import type { CurrentUserIdentity } from '../../contract/auth.ts';
import type { Delivery } from '../../contract/deliveries.ts';
import {
  badRequest,
  conflict,
  internalServerError,
  notFound,
  type DomainError,
} from '../../contract/errors.ts';
import { requireOrganizationWrite } from '../authorization.ts';
import { ApiDependencies } from '../context.ts';

const dataEffect = <A>(run: () => Promise<A>): Effect.Effect<A, DomainError> =>
  Effect.tryPromise({
    try: run,
    catch: (failure) => {
      console.error('turbodiff: delivery operation failed', failure);
      return internalServerError();
    },
  });

const serializeContract = (row: AcceptanceContractRow) => ({
  id: row.id,
  version: row.version,
  artifactId: row.artifact_id,
  status: row.status,
  createdAt: row.created_at,
});

const owned = (user: CurrentUserIdentity, id: number) =>
  dataEffect(() => getDelivery(id)).pipe(
    Effect.flatMap((row) =>
      row && user.organizationIds.includes(row.organization_id)
        ? Effect.succeed(row)
        : Effect.fail(notFound('Unknown delivery')),
    ),
  );

export interface DeliveryOperations {
  readonly get: (user: CurrentUserIdentity, id: number) => Effect.Effect<Delivery, DomainError>;
  readonly listMessages: (
    user: CurrentUserIdentity,
    id: number,
  ) => Effect.Effect<
    {
      items: Array<{
        id: number;
        role: 'user' | 'assistant' | 'system';
        body: string;
        authorUserId: string | null;
        createdAt: string;
      }>;
    },
    DomainError
  >;
  readonly createMessage: (
    user: CurrentUserIdentity,
    id: number,
    body: string,
  ) => Effect.Effect<
    {
      id: number;
      role: 'user' | 'assistant' | 'system';
      body: string;
      authorUserId: string | null;
      createdAt: string;
    },
    DomainError
  >;
  readonly startRun: (
    user: CurrentUserIdentity,
    id: number,
  ) => Effect.Effect<{ factoryRunId: number; stageRunId: number; status: 'queued' }, DomainError>;
  readonly replaceAcceptanceContract: (
    user: CurrentUserIdentity,
    id: number,
    artifactId: number,
    status: 'proposed' | 'active',
  ) => Effect.Effect<ReturnType<typeof serializeContract>, DomainError>;
}

export class DeliveryService extends Context.Tag('Turbodiff/DeliveryService')<
  DeliveryService,
  DeliveryOperations
>() {}

export const DeliveryServiceLive = Layer.effect(
  DeliveryService,
  Effect.gen(function* () {
    const dependencies = yield* ApiDependencies;

    const load = (user: CurrentUserIdentity, id: number) =>
      Effect.gen(function* () {
        const delivery = yield* owned(user, id);
        const [repository, acceptance, changes, runs] = yield* dataEffect(() =>
          Promise.all([
            getDeliveryRepository(id),
            activeAcceptanceContract(id),
            listChangesForDelivery(id),
            listFactoryRuns({ deliveryId: id }),
          ]),
        );
        if (!repository) return yield* Effect.fail(notFound('Unknown delivery repository'));
        const change = changes[0] ?? null;
        return {
          id: delivery.id,
          organizationId: delivery.organization_id,
          workItemId: delivery.work_item_id,
          repository: {
            id: repository.id,
            owner: repository.owner,
            name: repository.name,
            provider: repository.source_provider,
          },
          status: delivery.status,
          acceptanceContract: acceptance ? serializeContract(acceptance) : null,
          change: change
            ? {
                id: change.id,
                number: change.number,
                title: change.title,
                url: change.url,
                sourceRef: change.source_ref,
                targetRef: change.target_ref,
                status: change.status,
              }
            : null,
          factoryRuns: runs.map((run) => ({
            id: run.id,
            flowKey: run.flow_key,
            status: run.status,
            createdAt: run.created_at,
          })),
          createdAt: delivery.created_at,
          updatedAt: delivery.updated_at,
          completedAt: delivery.completed_at,
        } satisfies Delivery;
      });

    const serializeMessage = (message: Awaited<ReturnType<typeof createDeliveryMessage>>) => ({
      id: message.id,
      role: message.role,
      body: message.body,
      authorUserId: message.author_user_id,
      createdAt: message.created_at,
    });

    return {
      get: load,
      listMessages: (user, id) =>
        Effect.gen(function* () {
          yield* owned(user, id);
          const items = yield* dataEffect(() => listDeliveryMessages(id));
          return { items: items.map(serializeMessage) };
        }),
      createMessage: (user, id, rawBody) =>
        Effect.gen(function* () {
          const delivery = yield* owned(user, id);
          const body = rawBody.trim();
          if (!body) return yield* Effect.fail(badRequest('Message body is required'));
          return serializeMessage(
            yield* dataEffect(() =>
              createDeliveryMessage({
                delivery,
                authorUserId: user.session.authUserId,
                role: 'user',
                body,
              }),
            ),
          );
        }),
      startRun: (user, id) =>
        Effect.gen(function* () {
          const delivery = yield* owned(user, id);
          yield* requireOrganizationWrite(user, delivery.organization_id);
          if (delivery.status === 'completed' || delivery.status === 'cancelled') {
            return yield* Effect.fail(conflict(`Delivery is ${delivery.status}`));
          }
          const key = `delivery:${delivery.id}:${crypto.randomUUID()}`;
          const started = yield* dataEffect(() =>
            createFactoryRunWithStage(
              {
                organizationId: delivery.organization_id,
                flowKey: DELIVERY_FLOW.key,
                flowVersion: DELIVERY_FLOW.version,
                deliveryId: delivery.id,
                trigger: 'manual',
                actorUserId: user.session.authUserId,
                idempotencyKey: key,
              },
              {
                stageKey: DELIVERY_FLOW.initialStage,
                idempotencyKey: `${key}:${DELIVERY_FLOW.initialStage}:1`,
              },
            ),
          );
          yield* dataEffect(() => updateDeliveryStatus(delivery.id, 'active'));
          yield* dataEffect(() =>
            dependencies.enqueueFactory({
              kind: 'run_factory',
              factoryRunId: started.factoryRun.id,
              stageRunId: started.stageRun.id,
            }),
          );
          return {
            factoryRunId: started.factoryRun.id,
            stageRunId: started.stageRun.id,
            status: 'queued' as const,
          };
        }),
      replaceAcceptanceContract: (user, id, artifactId, status) =>
        Effect.gen(function* () {
          const delivery = yield* owned(user, id);
          yield* requireOrganizationWrite(user, delivery.organization_id);
          const artifact = yield* dataEffect(() => getArtifact(artifactId));
          if (
            !artifact ||
            artifact.organization_id !== delivery.organization_id ||
            artifact.kind !== 'acceptance_contract'
          ) {
            return yield* Effect.fail(notFound('Unknown acceptance-contract artifact'));
          }
          return serializeContract(
            yield* dataEffect(() =>
              createAcceptanceContract({
                delivery,
                artifact,
                status,
                createdByUserId: user.session.authUserId,
              }),
            ),
          );
        }),
    } satisfies DeliveryOperations;
  }),
);
