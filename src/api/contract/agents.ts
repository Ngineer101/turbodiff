import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from '@effect/platform';
import { Schema } from 'effect';
import { DomainError } from './errors.ts';

const PositiveInt = Schema.Int.pipe(Schema.positive());
const agentId = HttpApiSchema.param(
  'agentId',
  Schema.NumberFromString.pipe(Schema.int(), Schema.positive()),
);
const withDomainErrors = <
  Name extends string,
  Method extends 'GET' | 'POST' | 'PATCH' | 'DELETE',
  Path,
  UrlParams,
  Payload,
  Headers,
  Success,
  Error,
  R,
  RE,
>(
  endpoint: HttpApiEndpoint.HttpApiEndpoint<
    Name,
    Method,
    Path,
    UrlParams,
    Payload,
    Headers,
    Success,
    Error,
    R,
    RE
  >,
) => endpoint.addError(DomainError);

export const ModelOption = Schema.Struct({ id: Schema.String, label: Schema.String });
export const ModelCatalog = Schema.Struct({
  runner: Schema.Struct({
    options: Schema.Array(ModelOption),
    defaultModel: Schema.String,
    fastModel: Schema.String,
  }),
  reviewer: Schema.Struct({
    options: Schema.Array(ModelOption),
    defaultModel: Schema.String,
  }),
});
export type ModelCatalog = typeof ModelCatalog.Type;

export const AgentSummary = Schema.Struct({
  id: PositiveInt,
  slug: Schema.String,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  model: Schema.String,
  builtIn: Schema.Boolean,
});

export const Agent = Schema.Struct({
  ...AgentSummary.fields,
  instructions: Schema.String,
  installationId: PositiveInt,
});
export type Agent = typeof Agent.Type;

export const AgentCollection = Schema.Struct({
  items: Schema.Array(AgentSummary),
  githubAppSlug: Schema.String,
});
export type AgentCollection = typeof AgentCollection.Type;

export const AgentWrite = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  description: Schema.String,
  instructions: Schema.String,
  model: Schema.optional(Schema.String),
});
export type AgentWrite = typeof AgentWrite.Type;

export const AgentUpdate = Schema.Struct({
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  instructions: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
});
export type AgentUpdate = typeof AgentUpdate.Type;

export const AgentsApi = HttpApiGroup.make('agents')
  .add(withDomainErrors(HttpApiEndpoint.get('getModels', '/models').addSuccess(ModelCatalog)))
  .add(withDomainErrors(HttpApiEndpoint.get('listAgents', '/agents').addSuccess(AgentCollection)))
  .add(
    withDomainErrors(
      HttpApiEndpoint.post('createAgent', '/agents')
        .setPayload(AgentWrite)
        .addSuccess(Agent, { status: 201 }),
    ),
  )
  .add(withDomainErrors(HttpApiEndpoint.get('getAgent')`/agents/${agentId}`.addSuccess(Agent)))
  .add(
    withDomainErrors(
      HttpApiEndpoint.patch('updateAgent')`/agents/${agentId}`
        .setPayload(AgentUpdate)
        .addSuccess(Agent),
    ),
  )
  .add(
    withDomainErrors(
      HttpApiEndpoint.del('deleteAgent')`/agents/${agentId}`.addSuccess(Schema.Void, {
        status: 204,
      }),
    ),
  );
