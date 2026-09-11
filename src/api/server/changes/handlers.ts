import { HttpApiBuilder } from '@effect/platform';
import { Effect } from 'effect';
import { AppApi } from '../../contract/api.ts';
import { CurrentUser } from '../../contract/auth.ts';
import { ChangeService } from './service.ts';

export const ChangesHandlers = HttpApiBuilder.group(
  AppApi,
  'changes',
  Effect.fn(function* (handlers) {
    const service = yield* ChangeService;
    return handlers
      .handle('listChanges', ({ path, urlParams }) =>
        Effect.flatMap(CurrentUser, (user) =>
          service.list(user, path.repositoryId, urlParams.status),
        ),
      )
      .handle('getChange', ({ path }) =>
        Effect.flatMap(CurrentUser, (user) => service.get(user, path.changeId)),
      )
      .handle('createReviewRun', ({ path }) =>
        Effect.flatMap(CurrentUser, (user) => service.createReviewRun(user, path.changeId)),
      )
      .handle('getReviewRun', ({ path }) =>
        Effect.flatMap(CurrentUser, (user) => service.getReviewRun(user, path.reviewRunId)),
      );
  }),
);
