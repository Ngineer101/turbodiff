import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from '@effect/platform';
import { Schema } from 'effect';
import { DomainError } from './errors.ts';

const PositiveInt = Schema.Int.pipe(Schema.positive());
const connectionId = HttpApiSchema.param(
  'connectionId',
  Schema.NumberFromString.pipe(Schema.int(), Schema.positive()),
);
const repositoryId = HttpApiSchema.param(
  'repositoryId',
  Schema.NumberFromString.pipe(Schema.int(), Schema.positive()),
);
const withDomainErrors = <
  Name extends string,
  Method extends 'GET' | 'POST' | 'PUT' | 'DELETE',
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

export const Connection = Schema.Struct({
  id: PositiveInt,
  installationId: PositiveInt,
  name: Schema.String,
  kind: Schema.Literal('mcp', 'api'),
  url: Schema.String,
  tools: Schema.NullOr(Schema.Array(Schema.String)),
  hasAuth: Schema.Boolean,
  authType: Schema.Literal('none', 'bearer', 'api_key', 'client_credentials', 'oauth'),
  oauthStatus: Schema.NullOr(
    Schema.Literal('not_connected', 'connected', 'expired', 'needs_reauth'),
  ),
  repositories: Schema.Array(
    Schema.Struct({
      repositoryId: PositiveInt,
      reviews: Schema.Boolean,
      automations: Schema.Boolean,
    }),
  ),
});
export type Connection = typeof Connection.Type;

export const ConnectionCollection = Schema.Struct({
  encryptionConfigured: Schema.Boolean,
  installations: Schema.Array(Schema.Struct({ id: PositiveInt, accountLogin: Schema.String })),
  repositories: Schema.Array(
    Schema.Struct({
      id: PositiveInt,
      installationId: PositiveInt,
      owner: Schema.String,
      name: Schema.String,
    }),
  ),
  items: Schema.Array(Connection),
});
export type ConnectionCollection = typeof ConnectionCollection.Type;

export const CreateConnection = Schema.Struct({
  installationId: PositiveInt,
  name: Schema.String,
  kind: Schema.Literal('mcp', 'api'),
  url: Schema.String,
  tools: Schema.Array(Schema.String),
  authType: Schema.Literal('none', 'bearer', 'api_key', 'client_credentials', 'oauth'),
  token: Schema.optional(Schema.String),
  headerName: Schema.optional(Schema.String),
  headerValue: Schema.optional(Schema.String),
  clientId: Schema.optional(Schema.String),
  clientSecret: Schema.optional(Schema.String),
  tokenEndpoint: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.String),
});
export type CreateConnection = typeof CreateConnection.Type;

export const ConnectionTest = Schema.Struct({
  ok: Schema.Boolean,
  detail: Schema.String,
  tools: Schema.Array(Schema.String),
  reauthorizationRequired: Schema.Boolean,
});
export type ConnectionTest = typeof ConnectionTest.Type;

export const RepositoryConnection = Schema.Struct({
  attached: Schema.Boolean,
  reviews: Schema.Boolean,
  automations: Schema.Boolean,
});
export type RepositoryConnection = typeof RepositoryConnection.Type;

export const ConnectionsApi = HttpApiGroup.make('connections')
  .add(
    withDomainErrors(
      HttpApiEndpoint.get('listConnections', '/connections').addSuccess(ConnectionCollection),
    ),
  )
  .add(
    withDomainErrors(
      HttpApiEndpoint.post('createConnection', '/connections')
        .setPayload(CreateConnection)
        .addSuccess(Connection, { status: 201 }),
    ),
  )
  .add(
    withDomainErrors(
      HttpApiEndpoint.del('deleteConnection')`/connections/${connectionId}`.addSuccess(
        Schema.Void,
        { status: 204 },
      ),
    ),
  )
  .add(
    withDomainErrors(
      HttpApiEndpoint.post('testConnection')`/connections/${connectionId}/tests`.addSuccess(
        ConnectionTest,
      ),
    ),
  )
  .add(
    withDomainErrors(
      HttpApiEndpoint.put(
        'setRepositoryConnection',
      )`/connections/${connectionId}/repositories/${repositoryId}`
        .setPayload(RepositoryConnection)
        .addSuccess(RepositoryConnection),
    ),
  );
