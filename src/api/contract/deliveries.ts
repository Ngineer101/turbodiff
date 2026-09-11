import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from '@effect/platform';
import { Schema } from 'effect';
import { DomainError } from './errors.ts';

const PositiveInt = Schema.Int.pipe(Schema.positive());
const deliveryId = HttpApiSchema.param(
  'deliveryId',
  Schema.NumberFromString.pipe(Schema.int(), Schema.positive()),
);
const reviewRunId = HttpApiSchema.param(
  'reviewRunId',
  Schema.NumberFromString.pipe(Schema.int(), Schema.positive()),
);

const AgentRun = Schema.Struct({
  id: PositiveInt,
  kind: Schema.String,
  success: Schema.Boolean,
  createdAt: Schema.String,
});
const Verification = Schema.Struct({
  status: Schema.String,
  total: Schema.Number,
  failed: Schema.Number,
});
const Comment = Schema.Struct({
  id: PositiveInt,
  path: Schema.String,
  line: PositiveInt,
  side: Schema.String,
  body: Schema.String,
  author: Schema.String,
  status: Schema.String,
  createdAt: Schema.String,
  fixStatus: Schema.NullOr(Schema.String),
});
const ReviewRun = Schema.Struct({
  id: PositiveInt,
  profile: Schema.String,
  status: Schema.String,
  startStage: Schema.String,
  stopAfterStage: Schema.String,
  handoffReason: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  completedAt: Schema.NullOr(Schema.String),
  stages: Schema.Array(
    Schema.Struct({
      id: PositiveInt,
      stage: Schema.String,
      attempt: PositiveInt,
      status: Schema.String,
      verdict: Schema.NullOr(Schema.String),
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
      reason: Schema.NullOr(Schema.String),
      createdAt: Schema.String,
    }),
  ),
});

export const Delivery = Schema.Struct({
  delivery: Schema.Struct({
    id: PositiveInt,
    changeId: Schema.NullOr(PositiveInt),
    title: Schema.String,
    status: Schema.String,
    error: Schema.NullOr(Schema.String),
    pullRequestNumber: Schema.NullOr(PositiveInt),
    criteriaConflict: Schema.Boolean,
    proposedCriteria: Schema.NullOr(Schema.Array(Schema.String)),
  }),
  repository: Schema.Struct({
    id: PositiveInt,
    slug: Schema.String,
    provider: Schema.String,
  }),
  diffVersion: Schema.NullOr(Schema.String),
  nativeChangeNumber: Schema.NullOr(PositiveInt),
  checks: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      status: Schema.String,
      summary: Schema.NullOr(Schema.String),
    }),
  ),
  plan: Schema.NullOr(Schema.String),
  change: Schema.NullOr(
    Schema.Struct({
      state: Schema.String,
      url: Schema.NullOr(Schema.String),
      additions: Schema.Number,
      deletions: Schema.Number,
      changedFiles: Schema.Number,
      mergeability: Schema.NullOr(Schema.String),
    }),
  ),
  reviews: Schema.Array(
    Schema.Struct({
      state: Schema.String,
      body: Schema.String,
      author: Schema.NullOr(Schema.String),
    }),
  ),
  comments: Schema.Array(Comment),
  demo: Schema.NullOr(Schema.Struct({ url: Schema.String, caption: Schema.NullOr(Schema.String) })),
  certificateUrl: Schema.NullOr(Schema.String),
  criteria: Schema.Array(
    Schema.Struct({
      text: Schema.String,
      verdict: Schema.NullOr(Schema.String),
      note: Schema.NullOr(Schema.String),
      screenshotUrl: Schema.NullOr(Schema.String),
    }),
  ),
  verification: Schema.NullOr(Verification),
  agentRuns: Schema.Array(AgentRun),
  reviewRuns: Schema.Array(ReviewRun),
});
export type Delivery = typeof Delivery.Type;

const DiffFile = Schema.Struct({
  filename: Schema.String,
  status: Schema.String,
  additions: Schema.Number,
  deletions: Schema.Number,
  patch: Schema.NullOr(Schema.String),
});
export const DeliveryDiff = Schema.Struct({
  version: Schema.NullOr(Schema.String),
  files: Schema.Array(DiffFile),
  remainingFileCount: Schema.Number,
});
export type DeliveryDiff = typeof DeliveryDiff.Type;
const VersionQuery = Schema.Struct({ version: Schema.optional(Schema.String) });

const ExplanationRef = Schema.Struct({
  path: Schema.String,
  start: Schema.optional(PositiveInt),
  end: Schema.optional(PositiveInt),
});
const SketchLine = Schema.Struct({
  text: Schema.String,
  change: Schema.optional(Schema.Literal('+', '-')),
});
const SummaryBlock = Schema.Struct({ kind: Schema.Literal('summary'), text: Schema.String });
const SketchBlock = Schema.Struct({
  kind: Schema.Literal('call_tree', 'pseudocode', 'file_tree', 'component_tree'),
  title: Schema.String,
  text: Schema.String,
  lines: Schema.Array(SketchLine),
  refs: Schema.Array(ExplanationRef),
});
const SequenceBlock = Schema.Struct({
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
const ExplanationDocument = Schema.Struct({
  blocks: Schema.Array(Schema.Union(SummaryBlock, SketchBlock, SequenceBlock)),
});
export const DeliveryExplanation = Schema.Struct({
  version: Schema.NullOr(Schema.String),
  status: Schema.String,
  document: Schema.NullOr(ExplanationDocument),
  model: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  createdAt: Schema.NullOr(Schema.String),
  completedAt: Schema.NullOr(Schema.String),
  previous: Schema.NullOr(
    Schema.Struct({
      version: Schema.String,
      document: ExplanationDocument,
      completedAt: Schema.String,
    }),
  ),
});
export type DeliveryExplanation = typeof DeliveryExplanation.Type;
export const GenerateExplanation = Schema.Struct({
  version: Schema.String,
  force: Schema.optional(Schema.Boolean),
});
export type GenerateExplanation = typeof GenerateExplanation.Type;

export const CreateComment = Schema.Struct({
  path: Schema.String,
  line: PositiveInt,
  side: Schema.optional(Schema.Literal('additions', 'deletions')),
  body: Schema.String,
});
export type CreateComment = typeof CreateComment.Type;
const CommentCreated = Schema.Struct({ commentId: PositiveInt });
const FixRunAccepted = Schema.Struct({
  submittedCommentCount: PositiveInt,
  status: Schema.Literal('queued'),
});

const Message = Schema.Struct({
  id: PositiveInt,
  role: Schema.Literal('user', 'assistant'),
  body: Schema.String,
  author: Schema.NullOr(Schema.String),
  status: Schema.String,
  outcome: Schema.NullOr(Schema.String),
  commitSha: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});
const MessageCollection = Schema.Struct({ items: Schema.Array(Message) });
export const CreateMessage = Schema.Struct({ body: Schema.String });
export type CreateMessage = typeof CreateMessage.Type;
const MessageAccepted = Schema.Struct({ messageId: PositiveInt, status: Schema.Literal('queued') });

const ActionAccepted = Schema.Struct({ status: Schema.Literal('queued') });
const ResumeAccepted = Schema.Struct({
  status: Schema.Literal('queued'),
  stage: Schema.String,
  attempt: PositiveInt,
  stageRunId: PositiveInt,
});
export const ReplaceAcceptanceContract = Schema.Struct({ criteria: Schema.Array(Schema.String) });
export type ReplaceAcceptanceContract = typeof ReplaceAcceptanceContract.Type;
export const ResolveAcceptanceConflict = Schema.Struct({ resolution: Schema.Literal('keep') });
const MergeAccepted = Schema.Struct({
  status: Schema.Literal('queued', 'completed'),
  conflictResolutionQueued: Schema.Boolean,
});
const ClosureAccepted = Schema.Struct({
  status: Schema.Literal('queued', 'completed'),
  branchDeleted: Schema.Boolean,
});

export const DeliveriesApi = HttpApiGroup.make('deliveries')
  .add(
    HttpApiEndpoint.get('getDelivery')`/deliveries/${deliveryId}`
      .addSuccess(Delivery)
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.get('getDeliveryDiff')`/deliveries/${deliveryId}/diff`
      .setUrlParams(VersionQuery)
      .addSuccess(DeliveryDiff)
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.get('getDeliveryExplanation')`/deliveries/${deliveryId}/explanation`
      .setUrlParams(VersionQuery)
      .addSuccess(DeliveryExplanation)
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.post('generateDeliveryExplanation')`/deliveries/${deliveryId}/explanation`
      .setPayload(GenerateExplanation)
      .addSuccess(DeliveryExplanation, { status: 202 })
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.post('createDeliveryComment')`/deliveries/${deliveryId}/comments`
      .setPayload(CreateComment)
      .addSuccess(CommentCreated, { status: 201 })
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.post('createDeliveryFixRun')`/deliveries/${deliveryId}/fix-runs`
      .addSuccess(FixRunAccepted, { status: 202 })
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.get('listDeliveryMessages')`/deliveries/${deliveryId}/messages`
      .addSuccess(MessageCollection)
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.post('createDeliveryMessage')`/deliveries/${deliveryId}/messages`
      .setPayload(CreateMessage)
      .addSuccess(MessageAccepted, { status: 202 })
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.post('retryDelivery')`/deliveries/${deliveryId}/retry-attempts`
      .addSuccess(ActionAccepted, { status: 202 })
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.post('resumeReviewRun')`/review-runs/${reviewRunId}/resume-attempts`
      .addSuccess(ResumeAccepted, { status: 202 })
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.put('replaceAcceptanceContract')`/deliveries/${deliveryId}/acceptance-contract`
      .setPayload(ReplaceAcceptanceContract)
      .addSuccess(ActionAccepted, { status: 202 })
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.post(
      'resolveAcceptanceConflict',
    )`/deliveries/${deliveryId}/acceptance-resolutions`
      .setPayload(ResolveAcceptanceConflict)
      .addSuccess(ActionAccepted, { status: 202 })
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.post('mergeDelivery')`/deliveries/${deliveryId}/merge-attempts`
      .addSuccess(MergeAccepted, { status: 202 })
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.post('closeDelivery')`/deliveries/${deliveryId}/closure-attempts`
      .addSuccess(ClosureAccepted, { status: 202 })
      .addError(DomainError),
  );
