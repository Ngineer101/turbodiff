import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from '@effect/platform';
import { Schema } from 'effect';
import { DomainError } from './errors.ts';

const PositiveInt = Schema.Int.pipe(Schema.positive());
const idParam = (name: string) =>
  HttpApiSchema.param(name, Schema.NumberFromString.pipe(Schema.int(), Schema.positive()));
const WorkItemStatus = Schema.Literal(
  'open',
  'planning',
  'awaiting_approval',
  'approved',
  'in_progress',
  'completed',
  'cancelled',
);

export const WorkItemTarget = Schema.Struct({
  repositoryId: PositiveInt,
  owner: Schema.String,
  name: Schema.String,
  position: Schema.Int,
});

export const WorkItem = Schema.Struct({
  id: PositiveInt,
  organizationId: Schema.String,
  origin: Schema.Literal('idea', 'issue', 'external_change', 'automation', 'api'),
  title: Schema.String,
  description: Schema.String,
  status: WorkItemStatus,
  archivedAt: Schema.NullOr(Schema.String),
  approvedPlanArtifactId: Schema.NullOr(PositiveInt),
  attachments: Schema.Array(Schema.Struct({ artifactId: PositiveInt, name: Schema.String })),
  targets: Schema.Array(WorkItemTarget),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  completedAt: Schema.NullOr(Schema.String),
});
export type WorkItem = typeof WorkItem.Type;
export const WorkItemCollection = Schema.Struct({ items: Schema.Array(WorkItem) });
export type WorkItemCollection = typeof WorkItemCollection.Type;

export const CreateWorkItem = Schema.Struct({
  organizationId: Schema.String,
  repositoryIds: Schema.Array(PositiveInt),
  title: Schema.String,
  description: Schema.String,
  origin: Schema.optional(Schema.Literal('idea', 'api')),
});
export type CreateWorkItem = typeof CreateWorkItem.Type;

export const UpdateWorkItem = Schema.Struct({
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  status: Schema.optional(WorkItemStatus),
  archived: Schema.optional(Schema.Boolean),
  repositoryIds: Schema.optional(Schema.Array(PositiveInt)),
});
export type UpdateWorkItem = typeof UpdateWorkItem.Type;

const FactoryRunSummary = Schema.Struct({
  id: PositiveInt,
  flowKey: Schema.String,
  flowVersion: PositiveInt,
  status: Schema.Literal('queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled'),
  createdAt: Schema.String,
  startedAt: Schema.NullOr(Schema.String),
  completedAt: Schema.NullOr(Schema.String),
});
export const WorkItemFactoryRuns = Schema.Struct({ items: Schema.Array(FactoryRunSummary) });

export const WorkItemDelivery = Schema.Struct({
  id: PositiveInt,
  repositoryId: PositiveInt,
  status: Schema.Literal('pending', 'active', 'completed', 'failed', 'cancelled'),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  completedAt: Schema.NullOr(Schema.String),
});
export const WorkItemDeliveries = Schema.Struct({ items: Schema.Array(WorkItemDelivery) });

export const StartWorkItemFactoryRun = Schema.Struct({
  flow: Schema.Literal('planning', 'delivery'),
  model: Schema.optional(Schema.String),
  attachments: Schema.optional(
    Schema.Array(
      Schema.Struct({
        artifactId: PositiveInt,
        name: Schema.String,
      }),
    ),
  ),
});
export const WorkItemFactoryRunAccepted = Schema.Struct({
  factoryRunId: PositiveInt,
  stageRunId: PositiveInt,
  status: Schema.Literal('queued'),
});

export const ApprovePlan = Schema.Struct({ artifactId: PositiveInt });
export const ApprovedPlan = Schema.Struct({
  artifactId: PositiveInt,
  status: Schema.Literal('approved'),
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
    HttpApiEndpoint.get('getWorkItem')`/work-items/${idParam('workItemId')}`
      .addSuccess(WorkItem)
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.patch('updateWorkItem')`/work-items/${idParam('workItemId')}`
      .setPayload(UpdateWorkItem)
      .addSuccess(WorkItem)
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.del('deleteWorkItem')`/work-items/${idParam('workItemId')}`
      .addSuccess(HttpApiSchema.NoContent, { status: 204 })
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.get(
      'listWorkItemFactoryRuns',
    )`/work-items/${idParam('workItemId')}/factory-runs`
      .addSuccess(WorkItemFactoryRuns)
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.get('listWorkItemDeliveries')`/work-items/${idParam('workItemId')}/deliveries`
      .addSuccess(WorkItemDeliveries)
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.post(
      'startWorkItemFactoryRun',
    )`/work-items/${idParam('workItemId')}/factory-runs`
      .setPayload(StartWorkItemFactoryRun)
      .addSuccess(WorkItemFactoryRunAccepted, { status: 202 })
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.put('approveWorkItemPlan')`/work-items/${idParam('workItemId')}/approved-plan`
      .setPayload(ApprovePlan)
      .addSuccess(ApprovedPlan)
      .addError(DomainError),
  );
