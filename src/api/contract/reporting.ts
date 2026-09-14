import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform';
import { Schema } from 'effect';
import { DomainError } from './errors.ts';

const UsageBreakdown = Schema.Struct({
  key: Schema.String,
  runs: Schema.Number,
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  costUsd: Schema.Number,
});

export const UsageSummary = Schema.Struct({
  month: Schema.String,
  totals: Schema.Struct({
    agentRuns: Schema.Number,
    running: Schema.Number,
    inputTokens: Schema.Number,
    outputTokens: Schema.Number,
    cacheReadTokens: Schema.Number,
    cacheWriteTokens: Schema.Number,
    costUsd: Schema.Number,
  }),
  byAgent: Schema.Array(UsageBreakdown),
  byModel: Schema.Array(UsageBreakdown),
  byFlow: Schema.Array(UsageBreakdown),
});
export type UsageSummary = typeof UsageSummary.Type;

export const ReportingApi = HttpApiGroup.make('reporting').add(
  HttpApiEndpoint.get('getUsageSummary', '/usage-summary')
    .addSuccess(UsageSummary)
    .addError(DomainError),
);
