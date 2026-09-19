import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from '@effect/platform';
import { Schema } from 'effect';
import { DomainError } from './errors.ts';

const PositiveInt = Schema.Int.pipe(Schema.positive());
const factoryRunId = HttpApiSchema.param(
  'factoryRunId',
  Schema.NumberFromString.pipe(Schema.int(), Schema.positive()),
);
export const RunStatus = Schema.Literal(
  'queued',
  'running',
  'waiting',
  'succeeded',
  'failed',
  'cancelled',
);
const AgentRun = Schema.Struct({
  id: PositiveInt,
  agentId: PositiveInt,
  modelId: PositiveInt,
  inputArtifactId: PositiveInt,
  outputArtifactId: Schema.NullOr(PositiveInt),
  logArtifactId: Schema.NullOr(PositiveInt),
  status: Schema.Literal('queued', 'running', 'succeeded', 'failed', 'cancelled'),
  usage: Schema.Struct({
    inputTokens: Schema.Number,
    outputTokens: Schema.Number,
    cacheReadTokens: Schema.Number,
    cacheWriteTokens: Schema.Number,
    costUsd: Schema.Number,
  }),
  errorCode: Schema.NullOr(Schema.String),
  errorMessage: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  startedAt: Schema.NullOr(Schema.String),
  completedAt: Schema.NullOr(Schema.String),
});
export const FactoryRun = Schema.Struct({
  id: PositiveInt,
  organizationId: Schema.String,
  flowKey: Schema.String,
  flowVersion: PositiveInt,
  modelId: Schema.NullOr(PositiveInt),
  model: Schema.NullOr(Schema.String),
  workItemId: Schema.NullOr(PositiveInt),
  deliveryId: Schema.NullOr(PositiveInt),
  changeId: Schema.NullOr(PositiveInt),
  automationId: Schema.NullOr(PositiveInt),
  parentRunId: Schema.NullOr(PositiveInt),
  trigger: Schema.String,
  status: RunStatus,
  events: Schema.Array(
    Schema.Struct({
      id: PositiveInt,
      stageRunId: Schema.NullOr(PositiveInt),
      kind: Schema.String,
      payload: Schema.Unknown,
      createdAt: Schema.String,
    }),
  ),
  stages: Schema.Array(
    Schema.Struct({
      id: PositiveInt,
      stageKey: Schema.String,
      attempt: PositiveInt,
      status: Schema.String,
      errorCode: Schema.NullOr(Schema.String),
      errorMessage: Schema.NullOr(Schema.String),
      agentRuns: Schema.Array(AgentRun),
      createdAt: Schema.String,
      startedAt: Schema.NullOr(Schema.String),
      completedAt: Schema.NullOr(Schema.String),
    }),
  ),
  createdAt: Schema.String,
  startedAt: Schema.NullOr(Schema.String),
  completedAt: Schema.NullOr(Schema.String),
});
export type FactoryRun = typeof FactoryRun.Type;

export const ExecutionsApi = HttpApiGroup.make('executions').add(
  HttpApiEndpoint.get('getFactoryRun')`/factory-runs/${factoryRunId}`
    .addSuccess(FactoryRun)
    .addError(DomainError),
);
