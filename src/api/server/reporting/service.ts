import { Context, Effect, Layer } from 'effect';
import { usageSummary } from '../../../data/reporting.ts';
import type { CurrentUserIdentity } from '../../contract/auth.ts';
import type { UsageSummary } from '../../contract/reporting.ts';
import { internalServerError, type DomainError } from '../../contract/errors.ts';

const dataEffect = <A>(run: () => Promise<A>): Effect.Effect<A, DomainError> =>
  Effect.tryPromise({
    try: run,
    catch: (failure) => {
      console.error('turbodiff: reporting operation failed', failure);
      return internalServerError();
    },
  });

const breakdown = (rows: Awaited<ReturnType<typeof usageSummary>>['byAgent']) =>
  rows.map((row) => ({
    key: row.key,
    runs: row.runs,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsd: row.cost_usd,
  }));

export interface ReportingOperations {
  readonly usage: (user: CurrentUserIdentity) => Effect.Effect<UsageSummary, DomainError>;
}

export class ReportingService extends Context.Tag('Turbodiff/ReportingService')<
  ReportingService,
  ReportingOperations
>() {}

export const ReportingServiceLive = Layer.succeed(ReportingService, {
  usage: (user) => {
    const month = new Date().toISOString().slice(0, 7);
    return dataEffect(() => usageSummary(user.organizationIds, month)).pipe(
      Effect.map((summary) => ({
        month,
        totals: {
          agentRuns: summary.totals.agent_runs,
          running: summary.totals.running,
          inputTokens: summary.totals.input_tokens,
          outputTokens: summary.totals.output_tokens,
          cacheReadTokens: summary.totals.cache_read_tokens,
          cacheWriteTokens: summary.totals.cache_write_tokens,
          costUsd: summary.totals.cost_usd,
        },
        byAgent: breakdown(summary.byAgent),
        byModel: breakdown(summary.byModel),
        byFlow: breakdown(summary.byFlow),
      })),
    );
  },
} satisfies ReportingOperations);
