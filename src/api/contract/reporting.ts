import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform';
import { Schema } from 'effect';
import { DomainError } from './errors.ts';

const PositiveInt = Schema.Int.pipe(Schema.positive());

const UsageSession = Schema.Struct({
  kind: Schema.Literal('generate', 'review', 'fix', 'verify'),
  label: Schema.String,
  status: Schema.String,
  costUsd: Schema.Number,
  totalTokens: Schema.Number,
  durationSeconds: Schema.NullOr(Schema.Number),
  createdAt: Schema.String,
  url: Schema.NullOr(Schema.String),
});
const FeatureUsage = Schema.Struct({
  id: PositiveInt,
  title: Schema.String,
  repository: Schema.NullOr(Schema.String),
  status: Schema.String,
  pullRequestNumber: Schema.NullOr(PositiveInt),
  pullRequestUrl: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  totalCostUsd: Schema.Number,
  totalTokens: Schema.Number,
  sessions: Schema.Array(UsageSession),
});
export const UsageSummary = Schema.Struct({
  month: Schema.String,
  metrics: Schema.Struct({
    reviews: Schema.Number,
    reviewCostUsd: Schema.Number,
    pipelineCostUsd: Schema.Number,
    tokens: Schema.Number,
    averageDurationSeconds: Schema.NullOr(Schema.Number),
    averageFindings: Schema.NullOr(Schema.Number),
    running: Schema.Number,
  }),
  months: Schema.Array(
    Schema.Struct({
      month: Schema.String,
      reviews: Schema.Number,
      totalTokens: Schema.Number,
      pipelineCostUsd: Schema.Number,
    }),
  ),
  agents: Schema.Array(
    Schema.Struct({
      agentSlug: Schema.NullOr(Schema.String),
      reviews: Schema.Number,
      costUsd: Schema.Number,
    }),
  ),
  repositoryCount: Schema.Number,
  enabledRepositoryCount: Schema.Number,
  recentRepositories: Schema.Array(
    Schema.Struct({
      id: PositiveInt,
      owner: Schema.String,
      name: Schema.String,
      enabled: Schema.Boolean,
      suspended: Schema.Boolean,
      reviews: Schema.Number,
      costUsd: Schema.Number,
    }),
  ),
  features: Schema.Array(FeatureUsage),
  automations: Schema.Array(
    Schema.Struct({
      automationId: PositiveInt,
      name: Schema.String,
      repository: Schema.String,
      runs: Schema.Number,
      costUsd: Schema.Number,
    }),
  ),
});
export type UsageSummary = typeof UsageSummary.Type;

export const FactoryState = Schema.Struct({ version: Schema.Number });

export const ReportingApi = HttpApiGroup.make('reporting')
  .add(
    HttpApiEndpoint.get('getUsageSummary', '/usage-summary')
      .addSuccess(UsageSummary)
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.get('getFactoryState', '/factory-state')
      .addSuccess(FactoryState)
      .addError(DomainError),
  );
