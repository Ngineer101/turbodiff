import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from '@effect/platform';
import { Schema } from 'effect';
import { DomainError } from './errors.ts';

const PositiveInt = Schema.Int.pipe(Schema.positive());
const idParam = (name: string) =>
  HttpApiSchema.param(name, Schema.NumberFromString.pipe(Schema.int(), Schema.positive()));
const ChangeStatus = Schema.Literal('open', 'merged', 'closed');

const ChangeRevision = Schema.Struct({
  id: PositiveInt,
  version: PositiveInt,
  baseSha: Schema.String,
  headSha: Schema.String,
  artifactId: PositiveInt,
  reviewOutcomes: Schema.Array(
    Schema.Struct({
      agentRunId: PositiveInt,
      verdict: Schema.Literal('approve', 'comment', 'request_changes'),
      conclusion: Schema.Literal('ready', 'ready_with_warnings', 'not_ready', 'inconclusive'),
      coverageStatus: Schema.Literal('complete', 'incomplete', 'stale'),
      findingCount: Schema.Int,
      publicationUrl: Schema.NullOr(Schema.String),
      publishedAt: Schema.NullOr(Schema.String),
    }),
  ),
  createdAt: Schema.String,
});

export const Change = Schema.Struct({
  id: PositiveInt,
  organizationId: Schema.String,
  repositoryId: PositiveInt,
  deliveryId: Schema.NullOr(PositiveInt),
  providerIntegrationId: PositiveInt,
  providerKey: Schema.String,
  number: Schema.NullOr(PositiveInt),
  title: Schema.String,
  sourceRef: Schema.String,
  targetRef: Schema.String,
  url: Schema.NullOr(Schema.String),
  origin: Schema.Literal('human', 'factory', 'automation', 'imported'),
  status: ChangeStatus,
  currentRevision: Schema.NullOr(ChangeRevision),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type Change = typeof Change.Type;

export const ChangeCollection = Schema.Struct({ items: Schema.Array(Change) });
export const ChangeQuery = Schema.Struct({ status: Schema.optional(ChangeStatus) });
export const ReviewRunAccepted = Schema.Struct({
  factoryRunId: PositiveInt,
  stageRunId: PositiveInt,
  status: Schema.Literal('queued'),
});

export const ChangesApi = HttpApiGroup.make('changes')
  .add(
    HttpApiEndpoint.get('listChanges')`/repositories/${idParam('repositoryId')}/changes`
      .setUrlParams(ChangeQuery)
      .addSuccess(ChangeCollection)
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.get('getChange')`/changes/${idParam('changeId')}`
      .addSuccess(Change)
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.post('createReviewRun')`/changes/${idParam('changeId')}/review-runs`
      .addSuccess(ReviewRunAccepted, { status: 202 })
      .addError(DomainError),
  );
