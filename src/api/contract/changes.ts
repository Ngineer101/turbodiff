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
export const ChangeTransition = Schema.Struct({
  status: Schema.Literal('merged', 'closed'),
  branchDeleted: Schema.optional(Schema.Boolean),
});
export type ChangeTransition = typeof ChangeTransition.Type;

const ExplanationRef = Schema.Struct({
  path: Schema.String,
  start: Schema.optional(Schema.Int),
  end: Schema.optional(Schema.Int),
});
const ExplanationSketchLine = Schema.Struct({
  text: Schema.String,
  change: Schema.optional(Schema.Literal('+', '-')),
});
const ExplanationSummary = Schema.Struct({ kind: Schema.Literal('summary'), text: Schema.String });
const explanationSketch = (kind: 'call_tree' | 'pseudocode' | 'file_tree' | 'component_tree') =>
  Schema.Struct({
    kind: Schema.Literal(kind),
    title: Schema.String,
    text: Schema.String,
    lines: Schema.Array(ExplanationSketchLine),
    refs: Schema.Array(ExplanationRef),
  });
const ExplanationSequence = Schema.Struct({
  kind: Schema.Literal('sequence'),
  title: Schema.String,
  text: Schema.String,
  participants: Schema.Array(Schema.String),
  messages: Schema.Array(
    Schema.Struct({
      from: Schema.String,
      to: Schema.String,
      label: Schema.String,
      style: Schema.Literal('call', 'reply', 'error'),
    }),
  ),
  loop: Schema.optional(Schema.Struct({ label: Schema.String, from: Schema.Int, to: Schema.Int })),
  refs: Schema.Array(ExplanationRef),
});
export const ExplanationDocument = Schema.Struct({
  blocks: Schema.Array(
    Schema.Union(
      ExplanationSummary,
      explanationSketch('call_tree'),
      explanationSketch('pseudocode'),
      explanationSketch('file_tree'),
      explanationSketch('component_tree'),
      ExplanationSequence,
    ),
  ),
});
export const ChangeExplanation = Schema.Struct({
  revisionId: Schema.NullOr(PositiveInt),
  headSha: Schema.NullOr(Schema.String),
  status: Schema.Literal('none', 'queued', 'running', 'ready', 'failed'),
  artifactId: Schema.NullOr(PositiveInt),
  document: Schema.NullOr(ExplanationDocument),
  error: Schema.NullOr(Schema.String),
  createdAt: Schema.NullOr(Schema.String),
  completedAt: Schema.NullOr(Schema.String),
});
export type ChangeExplanation = typeof ChangeExplanation.Type;
export const StartExplanation = Schema.Struct({ force: Schema.optional(Schema.Boolean) });
export const ExplanationRunAccepted = Schema.Struct({
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
  )
  .add(
    HttpApiEndpoint.post('mergeChange')`/changes/${idParam('changeId')}/merges`
      .addSuccess(ChangeTransition)
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.post('closeChange')`/changes/${idParam('changeId')}/closures`
      .addSuccess(ChangeTransition)
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.get('getChangeExplanation')`/changes/${idParam('changeId')}/explanation`
      .addSuccess(ChangeExplanation)
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.post('createExplanationRun')`/changes/${idParam('changeId')}/explanation-runs`
      .setPayload(StartExplanation)
      .addSuccess(ExplanationRunAccepted, { status: 202 })
      .addError(DomainError),
  );
