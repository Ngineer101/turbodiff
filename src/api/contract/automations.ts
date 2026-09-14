import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from '@effect/platform';
import { Schema } from 'effect';
import { DomainError } from './errors.ts';

const PositiveInt = Schema.Int.pipe(Schema.positive());
const idParam = (name: string) =>
  HttpApiSchema.param(name, Schema.NumberFromString.pipe(Schema.int(), Schema.positive()));

export const Automation = Schema.Struct({
  id: PositiveInt,
  organizationId: Schema.String,
  agentId: PositiveInt,
  repositoryId: Schema.NullOr(PositiveInt),
  name: Schema.String,
  schedule: Schema.String,
  timezone: Schema.String,
  inputTemplate: Schema.Unknown,
  skillIds: Schema.Array(PositiveInt),
  integrationIds: Schema.Array(PositiveInt),
  enabled: Schema.Boolean,
  nextRunAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type Automation = typeof Automation.Type;

export const AutomationCollection = Schema.Struct({ items: Schema.Array(Automation) });
export type AutomationCollection = typeof AutomationCollection.Type;

export const CreateAutomation = Schema.Struct({
  organizationId: Schema.String,
  agentId: PositiveInt,
  repositoryId: Schema.optional(Schema.NullOr(PositiveInt)),
  name: Schema.String,
  schedule: Schema.String,
  timezone: Schema.optional(Schema.String),
  inputTemplate: Schema.Unknown,
  skillIds: Schema.optional(Schema.Array(PositiveInt)),
  integrationIds: Schema.optional(Schema.Array(PositiveInt)),
  enabled: Schema.optional(Schema.Boolean),
});
export type CreateAutomation = typeof CreateAutomation.Type;

export const UpdateAutomation = Schema.Struct({
  agentId: Schema.optional(PositiveInt),
  repositoryId: Schema.optional(Schema.NullOr(PositiveInt)),
  name: Schema.optional(Schema.String),
  schedule: Schema.optional(Schema.String),
  timezone: Schema.optional(Schema.String),
  inputTemplate: Schema.optional(Schema.Unknown),
  skillIds: Schema.optional(Schema.Array(PositiveInt)),
  integrationIds: Schema.optional(Schema.Array(PositiveInt)),
  enabled: Schema.optional(Schema.Boolean),
});
export type UpdateAutomation = typeof UpdateAutomation.Type;

export const AutomationRun = Schema.Struct({
  id: PositiveInt,
  automationId: PositiveInt,
  workItemId: Schema.NullOr(PositiveInt),
  status: Schema.Literal('queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled'),
  createdAt: Schema.String,
  startedAt: Schema.NullOr(Schema.String),
  completedAt: Schema.NullOr(Schema.String),
});
export type AutomationRun = typeof AutomationRun.Type;
export const AutomationRunCollection = Schema.Struct({ items: Schema.Array(AutomationRun) });
export const AutomationRunAccepted = Schema.Struct({
  factoryRunId: PositiveInt,
  status: Schema.Literal('queued'),
});

export const AutomationsApi = HttpApiGroup.make('automations')
  .add(
    HttpApiEndpoint.get('listAutomations', '/automations')
      .addSuccess(AutomationCollection)
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.post('createAutomation', '/automations')
      .setPayload(CreateAutomation)
      .addSuccess(Automation, { status: 201 })
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.get('getAutomation')`/automations/${idParam('automationId')}`
      .addSuccess(Automation)
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.patch('updateAutomation')`/automations/${idParam('automationId')}`
      .setPayload(UpdateAutomation)
      .addSuccess(Automation)
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.del('deleteAutomation')`/automations/${idParam('automationId')}`
      .addSuccess(HttpApiSchema.NoContent, { status: 204 })
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.get('listAutomationRuns')`/automations/${idParam('automationId')}/factory-runs`
      .addSuccess(AutomationRunCollection)
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.post('runAutomation')`/automations/${idParam('automationId')}/factory-runs`
      .addSuccess(AutomationRunAccepted, { status: 202 })
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.get('getAutomationRun')`/factory-runs/${idParam('runId')}/automation`
      .addSuccess(AutomationRun)
      .addError(DomainError),
  );
