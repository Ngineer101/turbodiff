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
      .handle('listDeliveryMessages', ({ path }) =>
        Effect.flatMap(CurrentUser, (user) => service.listMessages(user, path.deliveryId)),
      )
      .handle('createDeliveryMessage', ({ path, payload }) =>
        Effect.flatMap(CurrentUser, (user) =>
          service.createMessage(user, path.deliveryId, payload.body),
        ),
      )
      .handle('createDeliveryChatTurn', ({ path, payload }) =>
        Effect.flatMap(CurrentUser, (user) =>
          service.createChatTurn(user, path.deliveryId, payload.body),
        ),
      )
      .handle('startDeliveryRun', ({ path }) =>
        Effect.flatMap(CurrentUser, (user) => service.startRun(user, path.deliveryId)),
      )
      .handle('replaceAcceptanceContract', ({ path, payload }) =>
        Effect.flatMap(CurrentUser, (user) =>
          service.replaceAcceptanceContract(
            user,
            path.deliveryId,
            payload.artifactId,
            payload.status ?? 'active',
          ),
        ),
      );
  }),
);
