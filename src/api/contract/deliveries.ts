import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from '@effect/platform';
import { Schema } from 'effect';
import { PROCESS_PROFILES } from '../../domain/repository-policy.ts';
import { DomainError } from './errors.ts';

const PositiveInt = Schema.Int.pipe(Schema.positive());
const deliveryId = HttpApiSchema.param(
  'deliveryId',
  Schema.NumberFromString.pipe(Schema.int(), Schema.positive()),
);

const AcceptanceContract = Schema.Struct({
  id: PositiveInt,
  version: PositiveInt,
  artifactId: PositiveInt,
  status: Schema.Literal('proposed', 'active', 'rejected', 'superseded'),
  createdAt: Schema.String,
});

const DeliveryChange = Schema.Struct({
  id: PositiveInt,
  number: Schema.NullOr(PositiveInt),
  title: Schema.String,
  url: Schema.NullOr(Schema.String),
  sourceRef: Schema.String,
  targetRef: Schema.String,
  status: Schema.Literal('open', 'merged', 'closed'),
});

const FactoryRun = Schema.Struct({
  id: PositiveInt,
  flowKey: Schema.String,
  status: Schema.Literal('queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled'),
  createdAt: Schema.String,
});

export const Delivery = Schema.Struct({
  id: PositiveInt,
  organizationId: Schema.String,
  workItemId: PositiveInt,
  processProfile: Schema.Literal(...PROCESS_PROFILES),
  repository: Schema.Struct({
    id: PositiveInt,
    owner: Schema.String,
    name: Schema.String,
    provider: Schema.String,
  }),
  status: Schema.Literal('pending', 'active', 'completed', 'failed', 'cancelled'),
  acceptanceContract: Schema.NullOr(AcceptanceContract),
  change: Schema.NullOr(DeliveryChange),
  factoryRuns: Schema.Array(FactoryRun),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  completedAt: Schema.NullOr(Schema.String),
});
export type Delivery = typeof Delivery.Type;

export const DeliveryMessage = Schema.Struct({
  id: PositiveInt,
  role: Schema.Literal('user', 'assistant', 'system'),
  body: Schema.String,
  authorUserId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  factoryRunId: Schema.NullOr(PositiveInt),
  status: Schema.NullOr(
    Schema.Literal('queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled'),
  ),
  outcome: Schema.NullOr(Schema.Literal('changed', 'no_changes')),
  commitSha: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export type DeliveryMessage = typeof DeliveryMessage.Type;
export const DeliveryMessages = Schema.Struct({ items: Schema.Array(DeliveryMessage) });
export const CreateDeliveryMessage = Schema.Struct({ body: Schema.String });

export const ReplaceAcceptanceContract = Schema.Struct({
  artifactId: PositiveInt,
  status: Schema.optional(Schema.Literal('proposed', 'active')),
});

export const StartDeliveryRun = Schema.Struct({});
export const DeliveryRunAccepted = Schema.Struct({
  factoryRunId: PositiveInt,
  stageRunId: PositiveInt,
  status: Schema.Literal('queued'),
});

export const DeliveriesApi = HttpApiGroup.make('deliveries')
  .add(
    HttpApiEndpoint.get('getDelivery')`/deliveries/${deliveryId}`
      .addSuccess(Delivery)
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.get('listDeliveryMessages')`/deliveries/${deliveryId}/messages`
      .addSuccess(DeliveryMessages)
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.post('createDeliveryMessage')`/deliveries/${deliveryId}/messages`
      .setPayload(CreateDeliveryMessage)
      .addSuccess(DeliveryMessage, { status: 201 })
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.post('createDeliveryChatTurn')`/deliveries/${deliveryId}/chat-turns`
      .setPayload(CreateDeliveryMessage)
      .addSuccess(DeliveryMessage, { status: 202 })
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.post('startDeliveryRun')`/deliveries/${deliveryId}/factory-runs`
      .setPayload(StartDeliveryRun)
      .addSuccess(DeliveryRunAccepted, { status: 202 })
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.put('replaceAcceptanceContract')`/deliveries/${deliveryId}/acceptance-contract`
      .setPayload(ReplaceAcceptanceContract)
      .addSuccess(AcceptanceContract)
      .addError(DomainError),
  );
