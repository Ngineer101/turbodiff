import { HttpApiBuilder } from '@effect/platform';
import { Effect } from 'effect';
import { AppApi } from '../../contract/api.ts';
import { CurrentUser } from '../../contract/auth.ts';
import { PlatformService } from './service.ts';

export const PlatformHandlers = HttpApiBuilder.group(
  AppApi,
  'platform',
  Effect.fn(function* (handlers) {
    const service = yield* PlatformService;
    return handlers
      .handle('getCurrentUser', () => Effect.map(CurrentUser, (user) => service.currentUser(user)))
      .handle('createPushSubscription', ({ payload }) =>
        Effect.flatMap(CurrentUser, (user) => service.subscribe(user, payload)),
      )
      .handle('deletePushSubscription', ({ payload }) =>
        Effect.flatMap(CurrentUser, (user) => service.unsubscribe(user, payload.endpoint)),
      );
  }),
);
