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
      .handle('resumeDelivery', ({ path }) =>
        Effect.flatMap(CurrentUser, (user) => service.resumeDelivery(user, path.changeId)),
      )
      .handle('mergeChange', ({ path }) =>
        Effect.flatMap(CurrentUser, (user) => service.merge(user, path.changeId)),
      )
      .handle('closeChange', ({ path }) =>
        Effect.flatMap(CurrentUser, (user) => service.close(user, path.changeId)),
      )
      .handle('getChangeExplanation', ({ path }) =>
        Effect.flatMap(CurrentUser, (user) => service.getExplanation(user, path.changeId)),
      )
      .handle('createExplanationRun', ({ path, payload }) =>
        Effect.flatMap(CurrentUser, (user) =>
          service.createExplanationRun(user, path.changeId, payload.force ?? false),
        ),
      );
  }),
);
