import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from '@effect/platform';
import { Schema } from 'effect';
import { DomainError } from './errors.ts';

const PositiveInt = Schema.Int.pipe(Schema.positive());
const IdParam = (name: string) =>
  HttpApiSchema.param(name, Schema.NumberFromString.pipe(Schema.int(), Schema.positive()));

export const RepositorySummary = Schema.Struct({
  id: PositiveInt,
  owner: Schema.String,
  name: Schema.String,
});

export const AutomationRunSummary = Schema.Struct({
  id: PositiveInt,
  status: Schema.Literal('running', 'pr_opened', 'no_changes', 'checks_failed', 'failed'),
  pullRequestNumber: Schema.NullOr(PositiveInt),
  error: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});

export const Automation = Schema.Struct({
  id: PositiveInt,
  name: Schema.String,
  prompt: Schema.String,
  repository: RepositorySummary,
  scheduleKind: Schema.Literal('hourly', 'daily', 'weekly'),
  timeOfDay: Schema.NullOr(Schema.String),
  dayOfWeek: Schema.NullOr(Schema.Int),
  enabled: Schema.Boolean,
  runnerModel: Schema.NullOr(Schema.String),
  nextRunAt: Schema.String,
  lastRun: Schema.NullOr(
    Schema.Struct({
      id: PositiveInt,
      status: Schema.String,
      createdAt: Schema.String,
    }),
  ),
});

export type Automation = typeof Automation.Type;

export const AutomationCollection = Schema.Struct({
  items: Schema.Array(Automation),
  repositories: Schema.Array(
    Schema.Struct({
      id: PositiveInt,
      owner: Schema.String,
      name: Schema.String,
      installationId: PositiveInt,
    }),
  ),
});

export type AutomationCollection = typeof AutomationCollection.Type;

const AutomationWrite = Schema.Struct({
  name: Schema.String,
  prompt: Schema.String,
  scheduleKind: Schema.Literal('hourly', 'daily', 'weekly'),
  timeOfDay: Schema.NullOr(Schema.String),
  dayOfWeek: Schema.NullOr(Schema.Int),
  runnerModel: Schema.NullOr(Schema.String),
});

export const CreateAutomation = Schema.Struct({
  repositoryId: PositiveInt,
  ...AutomationWrite.fields,
});

export type CreateAutomation = typeof CreateAutomation.Type;

export const UpdateAutomation = Schema.Struct({
  name: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  scheduleKind: Schema.optional(Schema.Literal('hourly', 'daily', 'weekly')),
  timeOfDay: Schema.optional(Schema.NullOr(Schema.String)),
  dayOfWeek: Schema.optional(Schema.NullOr(Schema.Int)),
  runnerModel: Schema.optional(Schema.NullOr(Schema.String)),
  enabled: Schema.optional(Schema.Boolean),
});

export type UpdateAutomation = typeof UpdateAutomation.Type;

export const AutomationRunCollection = Schema.Struct({
  automation: Schema.Struct({ id: PositiveInt, name: Schema.String }),
  items: Schema.Array(AutomationRunSummary),
});

export type AutomationRunCollection = typeof AutomationRunCollection.Type;

export const AutomationRunDetail = Schema.Struct({
  ...AutomationRunSummary.fields,
  automation: Schema.Struct({
    id: PositiveInt,
    name: Schema.String,
    repository: Schema.String,
  }),
  agentRuns: Schema.Array(
    Schema.Struct({
      id: PositiveInt,
      kind: Schema.String,
      success: Schema.Boolean,
      createdAt: Schema.String,
    }),
  ),
});

export type AutomationRunDetail = typeof AutomationRunDetail.Type;

export const AutomationRunAccepted = Schema.Struct({
  automationId: PositiveInt,
  status: Schema.Literal('queued'),
});

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

export const AutomationsApi = HttpApiGroup.make('automations')
  .add(
    withDomainErrors(
      HttpApiEndpoint.get('listAutomations', '/automations').addSuccess(AutomationCollection),
    ),
  )
  .add(
    withDomainErrors(
      HttpApiEndpoint.post('createAutomation', '/automations')
        .setPayload(CreateAutomation)
        .addSuccess(Automation, { status: 201 }),
    ),
  )
  .add(
    withDomainErrors(
      HttpApiEndpoint.get('getAutomation')`/automations/${IdParam('automationId')}`.addSuccess(
        Automation,
      ),
    ),
  )
  .add(
    withDomainErrors(
      HttpApiEndpoint.patch('updateAutomation')`/automations/${IdParam('automationId')}`
        .setPayload(UpdateAutomation)
        .addSuccess(Automation),
    ),
  )
  .add(
    withDomainErrors(
      HttpApiEndpoint.del('deleteAutomation')`/automations/${IdParam('automationId')}`.addSuccess(
        Schema.Void,
        { status: 204 },
      ),
    ),
  )
  .add(
    withDomainErrors(
      HttpApiEndpoint.get(
        'listAutomationRuns',
      )`/automations/${IdParam('automationId')}/runs`.addSuccess(AutomationRunCollection),
    ),
  )
  .add(
    withDomainErrors(
      HttpApiEndpoint.post(
        'runAutomation',
      )`/automations/${IdParam('automationId')}/runs`.addSuccess(AutomationRunAccepted, {
        status: 202,
      }),
    ),
  )
  .add(
    withDomainErrors(
      HttpApiEndpoint.get('getAutomationRun')`/automation-runs/${IdParam('runId')}`.addSuccess(
        AutomationRunDetail,
      ),
    ),
  );
