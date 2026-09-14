import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from '@effect/platform';
import { Schema } from 'effect';
import { DomainError } from './errors.ts';

const PositiveInt = Schema.Int.pipe(Schema.positive());
const integrationId = HttpApiSchema.param(
  'integrationId',
  Schema.NumberFromString.pipe(Schema.int(), Schema.positive()),
);
const IntegrationKind = Schema.Literal('scm', 'artifact_store', 'mcp', 'api');

export const Integration = Schema.Struct({
  id: PositiveInt,
  organizationId: Schema.String,
  kind: IntegrationKind,
  provider: Schema.String,
  name: Schema.String,
  externalAccountId: Schema.NullOr(Schema.String),
  config: Schema.Unknown,
  hasCredentials: Schema.Boolean,
  needsReauthorization: Schema.Boolean,
  enabled: Schema.Boolean,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type Integration = typeof Integration.Type;
export const IntegrationCollection = Schema.Struct({ items: Schema.Array(Integration) });
export type IntegrationCollection = typeof IntegrationCollection.Type;
export const CreateIntegration = Schema.Struct({
  organizationId: Schema.String,
  kind: IntegrationKind,
  provider: Schema.String,
  name: Schema.String,
  externalAccountId: Schema.optional(Schema.NullOr(Schema.String)),
  config: Schema.optional(Schema.Unknown),
  credential: Schema.optional(Schema.String),
});
export type CreateIntegration = typeof CreateIntegration.Type;
export const UpdateIntegration = Schema.Struct({
  name: Schema.optional(Schema.String),
  config: Schema.optional(Schema.Unknown),
  credential: Schema.optional(Schema.NullOr(Schema.String)),
  enabled: Schema.optional(Schema.Boolean),
});
export type UpdateIntegration = typeof UpdateIntegration.Type;

export const IntegrationsApi = HttpApiGroup.make('integrations')
  .add(
    HttpApiEndpoint.get('listIntegrations', '/integrations')
      .addSuccess(IntegrationCollection)
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.post('createIntegration', '/integrations')
      .setPayload(CreateIntegration)
      .addSuccess(Integration, { status: 201 })
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.get('getIntegration')`/integrations/${integrationId}`
      .addSuccess(Integration)
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.patch('updateIntegration')`/integrations/${integrationId}`
      .setPayload(UpdateIntegration)
      .addSuccess(Integration)
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.del('deleteIntegration')`/integrations/${integrationId}`
      .addSuccess(HttpApiSchema.NoContent, { status: 204 })
      .addError(DomainError),
  );
