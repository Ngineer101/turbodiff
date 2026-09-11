import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from '@effect/platform';
import { Schema } from 'effect';
import { DomainError } from './errors.ts';

const PositiveInt = Schema.Int.pipe(Schema.positive());
const idParam = (name: string) =>
  HttpApiSchema.param(name, Schema.NumberFromString.pipe(Schema.int(), Schema.positive()));
const workItemId = idParam('workItemId');
const planningRunId = idParam('planningRunId');

export const WorkItemTarget = Schema.Struct({
  repositoryId: PositiveInt,
  owner: Schema.String,
  name: Schema.String,
  provider: Schema.String,
  enabled: Schema.Boolean,
});

export const WorkItem = Schema.Struct({
  id: PositiveInt,
  installationId: PositiveInt,
  origin: Schema.Literal('idea', 'issue', 'external_change', 'automation', 'api'),
  title: Schema.String,
  description: Schema.String,
  status: Schema.Literal('open', 'closed'),
  runnerModel: Schema.NullOr(Schema.String),
  planningRunId: Schema.NullOr(PositiveInt),
  targets: Schema.Array(WorkItemTarget),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type WorkItem = typeof WorkItem.Type;

export const WorkItemCollection = Schema.Struct({ items: Schema.Array(WorkItem) });
export type WorkItemCollection = typeof WorkItemCollection.Type;

export const CreateWorkItem = Schema.Struct({
  installationId: PositiveInt,
  repositoryIds: Schema.Array(PositiveInt),
  title: Schema.String,
  description: Schema.String,
  origin: Schema.optional(Schema.Literal('idea', 'issue', 'external_change', 'automation', 'api')),
  runnerModel: Schema.optional(Schema.String),
});
export type CreateWorkItem = typeof CreateWorkItem.Type;

export const UpdateWorkItem = Schema.Struct({
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Literal('open', 'closed')),
  runnerModel: Schema.optional(Schema.String),
  repositoryIds: Schema.optional(Schema.Array(PositiveInt)),
});
export type UpdateWorkItem = typeof UpdateWorkItem.Type;

const Attachment = Schema.Struct({
  key: Schema.String,
  name: Schema.String,
  contentType: Schema.String,
});
export const StartPlanningRun = Schema.Struct({
  title: Schema.optional(Schema.String),
  requirements: Schema.optional(Schema.String),
  attachments: Schema.optional(Schema.Array(Attachment)),
  model: Schema.optional(Schema.String),
});
export type StartPlanningRun = typeof StartPlanningRun.Type;

const PlanningQuestion = Schema.Struct({
  text: Schema.String,
  options: Schema.optional(Schema.Array(Schema.String)),
  recommended: Schema.optional(Schema.String),
});
const VerificationSummary = Schema.Struct({
  status: Schema.String,
  total: Schema.Number,
  failed: Schema.Number,
});
const PlanningRunTarget = Schema.Struct({
  repositoryId: PositiveInt,
  owner: Schema.String,
  name: Schema.String,
  provider: Schema.String,
  deliveryId: Schema.NullOr(PositiveInt),
  changeId: Schema.NullOr(PositiveInt),
  pullRequestNumber: Schema.NullOr(PositiveInt),
  status: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  verification: Schema.NullOr(VerificationSummary),
});
const AgentRun = Schema.Struct({
  id: PositiveInt,
  kind: Schema.String,
  success: Schema.Boolean,
  createdAt: Schema.String,
});

export const PlanningRun = Schema.Struct({
  id: PositiveInt,
  workItemId: Schema.NullOr(PositiveInt),
  title: Schema.String,
  status: Schema.String,
  error: Schema.NullOr(Schema.String),
  questions: Schema.Array(PlanningQuestion),
  acceptance: Schema.Array(Schema.String),
  plan: Schema.NullOr(Schema.String),
  summary: Schema.NullOr(Schema.String),
  archived: Schema.Boolean,
  model: Schema.String,
  attachments: Schema.Array(Schema.Struct({ name: Schema.String })),
  targets: Schema.Array(PlanningRunTarget),
  agentRuns: Schema.Array(AgentRun),
  createdAt: Schema.String,
});
export type PlanningRun = typeof PlanningRun.Type;

export const PlanningRunAccepted = Schema.Struct({
  planningRunId: PositiveInt,
  status: Schema.Literal('queued'),
});

export const UpdatePlanningRun = Schema.Struct({
  model: Schema.optional(Schema.String),
  archived: Schema.optional(Schema.Boolean),
});
export type UpdatePlanningRun = typeof UpdatePlanningRun.Type;

export const PlanningAnswers = Schema.Struct({ answers: Schema.Array(Schema.String) });
export const PlanningFeedback = Schema.Struct({
  comments: Schema.Array(
    Schema.Struct({ snippet: Schema.optional(Schema.String), comment: Schema.String }),
  ),
});
export const PlanningActionAccepted = Schema.Struct({ status: Schema.Literal('queued') });
export const PlanningApprovalAccepted = Schema.Struct({
  status: Schema.Literal('queued'),
  deliveryIds: Schema.Array(PositiveInt),
});

export const WorkItemsApi = HttpApiGroup.make('workItems')
  .add(
    HttpApiEndpoint.get('listWorkItems', '/work-items')
      .addSuccess(WorkItemCollection)
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.post('createWorkItem', '/work-items')
      .setPayload(CreateWorkItem)
      .addSuccess(WorkItem, { status: 201 })
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.get('getWorkItem')`/work-items/${workItemId}`
      .addSuccess(WorkItem)
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.patch('updateWorkItem')`/work-items/${workItemId}`
      .setPayload(UpdateWorkItem)
      .addSuccess(WorkItem)
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.del('deleteWorkItem')`/work-items/${workItemId}`
      .addSuccess(HttpApiSchema.NoContent, { status: 204 })
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.post('startPlanningRun')`/work-items/${workItemId}/planning-runs`
      .setPayload(StartPlanningRun)
      .addSuccess(PlanningRunAccepted, { status: 202 })
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.get('getPlanningRun')`/planning-runs/${planningRunId}`
      .addSuccess(PlanningRun)
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.patch('updatePlanningRun')`/planning-runs/${planningRunId}`
      .setPayload(UpdatePlanningRun)
      .addSuccess(PlanningRun)
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.put('answerPlanningRun')`/planning-runs/${planningRunId}/answers`
      .setPayload(PlanningAnswers)
      .addSuccess(PlanningActionAccepted, { status: 202 })
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.post('retryPlanningRun')`/planning-runs/${planningRunId}/retry-attempts`
      .addSuccess(PlanningActionAccepted, { status: 202 })
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.post('approvePlanningRun')`/planning-runs/${planningRunId}/approvals`
      .addSuccess(PlanningApprovalAccepted, { status: 202 })
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.post('addPlanningFeedback')`/planning-runs/${planningRunId}/feedback`
      .setPayload(PlanningFeedback)
      .addSuccess(PlanningActionAccepted, { status: 202 })
      .addError(DomainError),
  );
