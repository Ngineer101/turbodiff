import { HttpApiBuilder } from '@effect/platform';
import { Effect } from 'effect';
import { AppApi } from '../../contract/api.ts';
import { CurrentUser } from '../../contract/auth.ts';
import { ReportingService } from './service.ts';

export const ReportingHandlers = HttpApiBuilder.group(
  AppApi,
  'reporting',
  Effect.fn(function* (handlers) {
    const service = yield* ReportingService;
    return handlers
      .handle('getUsageSummary', () => Effect.flatMap(CurrentUser, service.usage))
      .handle('getFactoryState', () => service.factoryState());
  }),
);
