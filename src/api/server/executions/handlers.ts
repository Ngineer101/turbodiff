import { HttpApiBuilder } from '@effect/platform';
import { Effect } from 'effect';
import { AppApi } from '../../contract/api.ts';
import { CurrentUser } from '../../contract/auth.ts';
import { ExecutionService } from './service.ts';

export const ExecutionsHandlers = HttpApiBuilder.group(
  AppApi,
  'executions',
  Effect.fn(function* (handlers) {
    const service = yield* ExecutionService;
    return handlers.handle('getFactoryRun', ({ path }) =>
      Effect.flatMap(CurrentUser, (user) => service.get(user, path.factoryRunId)),
    );
  }),
);
