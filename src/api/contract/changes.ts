import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from '@effect/platform';
import { Schema } from 'effect';
import { DomainError } from './errors.ts';

const PositiveInt = Schema.Int.pipe(Schema.positive());
const changeId = HttpApiSchema.param(
  'changeId',
  Schema.NumberFromString.pipe(Schema.int(), Schema.positive()),
);
const repositoryId = HttpApiSchema.param(
  'repositoryId',
  Schema.NumberFromString.pipe(Schema.int(), Schema.positive()),
);
const reviewRunId = HttpApiSchema.param(
  'reviewRunId',
  Schema.NumberFromString.pipe(Schema.int(), Schema.positive()),
);
const ChangeStatus = Schema.Literal('open', 'merged', 'closed');

export const Change = Schema.Struct({
  id: PositiveInt,
  repositoryId: PositiveInt,
  providerKey: Schema.String,
  number: PositiveInt,
  origin: Schema.Literal('human', 'factory', 'automation', 'imported'),
  title: Schema.String,
  externalUrl: Schema.NullOr(Schema.String),
  sourceBranch: Schema.String,
  targetBranch: Schema.String,
  status: ChangeStatus,
  sourceHead: Schema.NullOr(Schema.String),
  targetHead: Schema.NullOr(Schema.String),
  draft: Schema.Boolean,
  capabilities: Schema.Array(
    Schema.Literal(
      'read_change',
      'publish_review',
      'write_head',
      'publish_check',
      'merge',
      'merge_queue',
    ),
  ),
  providerUpdatedAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type Change = typeof Change.Type;

export const ChangeCollection = Schema.Struct({ items: Schema.Array(Change) });
export const ChangeQuery = Schema.Struct({ status: Schema.optional(ChangeStatus) });
export const ReviewRunAccepted = Schema.Struct({
  reviewRunId: PositiveInt,
  stageRunId: Schema.NullOr(PositiveInt),
  status: Schema.Literal('queued'),
});
export const ReviewRun = Schema.Struct({
  id: PositiveInt,
  changeId: Schema.NullOr(PositiveInt),
  profile: Schema.String,
  status: Schema.String,
  startStage: Schema.String,
  stopAfterStage: Schema.String,
  handoffReason: Schema.NullOr(Schema.String),
  stages: Schema.Array(
    Schema.Struct({
      id: PositiveInt,
      stage: Schema.String,
      attempt: PositiveInt,
      status: Schema.String,
      error: Schema.NullOr(Schema.String),
      startedAt: Schema.NullOr(Schema.String),
      completedAt: Schema.NullOr(Schema.String),
    }),
  ),
  events: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      kind: Schema.String,
      decision: Schema.NullOr(Schema.String),
      createdAt: Schema.String,
    }),
  ),
  createdAt: Schema.String,
  completedAt: Schema.NullOr(Schema.String),
});
export type ReviewRun = typeof ReviewRun.Type;

export const ChangesApi = HttpApiGroup.make('changes')
  .add(
    HttpApiEndpoint.get('listChanges')`/repositories/${repositoryId}/changes`
      .setUrlParams(ChangeQuery)
      .addSuccess(ChangeCollection)
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.get('getChange')`/changes/${changeId}`.addSuccess(Change).addError(DomainError),
  )
  .add(
    HttpApiEndpoint.post('createReviewRun')`/changes/${changeId}/review-runs`
      .addSuccess(ReviewRunAccepted, { status: 202 })
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.get('getReviewRun')`/review-runs/${reviewRunId}`
      .addSuccess(ReviewRun)
      .addError(DomainError),
  );
