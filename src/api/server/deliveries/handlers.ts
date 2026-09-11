import { HttpApiBuilder } from '@effect/platform';
import { Effect } from 'effect';
import { AppApi } from '../../contract/api.ts';
import { CurrentUser } from '../../contract/auth.ts';
import { DeliveryService } from './service.ts';

export const DeliveriesHandlers = HttpApiBuilder.group(
  AppApi,
  'deliveries',
  Effect.fn(function* (handlers) {
    const service = yield* DeliveryService;
    return handlers
      .handle('getDelivery', ({ path }) =>
        Effect.flatMap(CurrentUser, (user) => service.get(user, path.deliveryId)),
      )
      .handle('getDeliveryDiff', ({ path, urlParams }) =>
        Effect.flatMap(CurrentUser, (user) =>
          service.diff(user, path.deliveryId, urlParams.version),
        ),
      )
      .handle('getDeliveryExplanation', ({ path, urlParams }) =>
        Effect.flatMap(CurrentUser, (user) =>
          service.explanation(user, path.deliveryId, urlParams.version),
        ),
      )
      .handle('generateDeliveryExplanation', ({ path, payload }) =>
        Effect.flatMap(CurrentUser, (user) =>
          service.generateExplanation(user, path.deliveryId, payload),
        ),
      )
      .handle('createDeliveryComment', ({ path, payload }) =>
        Effect.flatMap(CurrentUser, (user) =>
          service.createComment(user, path.deliveryId, payload),
        ),
      )
      .handle('createDeliveryFixRun', ({ path }) =>
        Effect.flatMap(CurrentUser, (user) => service.createFixRun(user, path.deliveryId)),
      )
      .handle('listDeliveryMessages', ({ path }) =>
        Effect.flatMap(CurrentUser, (user) => service.listMessages(user, path.deliveryId)),
      )
      .handle('createDeliveryMessage', ({ path, payload }) =>
        Effect.flatMap(CurrentUser, (user) =>
          service.createMessage(user, path.deliveryId, payload),
        ),
      )
      .handle('retryDelivery', ({ path }) =>
        Effect.flatMap(CurrentUser, (user) => service.retry(user, path.deliveryId)),
      )
      .handle('resumeReviewRun', ({ path }) =>
        Effect.flatMap(CurrentUser, (user) => service.resumeReviewRun(user, path.reviewRunId)),
      )
      .handle('replaceAcceptanceContract', ({ path, payload }) =>
        Effect.flatMap(CurrentUser, (user) =>
          service.replaceAcceptanceContract(user, path.deliveryId, payload),
        ),
      )
      .handle('resolveAcceptanceConflict', ({ path }) =>
        Effect.flatMap(CurrentUser, (user) =>
          service.resolveAcceptanceConflict(user, path.deliveryId),
        ),
      )
      .handle('mergeDelivery', ({ path }) =>
        Effect.flatMap(CurrentUser, (user) => service.merge(user, path.deliveryId)),
      )
      .handle('closeDelivery', ({ path }) =>
        Effect.flatMap(CurrentUser, (user) => service.close(user, path.deliveryId)),
      );
  }),
);
