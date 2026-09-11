import { HttpApiBuilder } from '@effect/platform';
import { Effect } from 'effect';
import { AppApi } from '../../contract/api.ts';
import { CurrentUser } from '../../contract/auth.ts';
import { ConnectionService } from './service.ts';

export const ConnectionsHandlers = HttpApiBuilder.group(
  AppApi,
  'connections',
  Effect.fn(function* (handlers) {
    const service = yield* ConnectionService;
    return handlers
      .handle('listConnections', () => Effect.flatMap(CurrentUser, service.list))
      .handle('createConnection', ({ payload }) =>
        Effect.flatMap(CurrentUser, (user) => service.create(user, payload)),
      )
      .handle('deleteConnection', ({ path }) =>
        Effect.flatMap(CurrentUser, (user) => service.remove(user, path.connectionId)),
      )
      .handle('testConnection', ({ path }) =>
        Effect.flatMap(CurrentUser, (user) => service.test(user, path.connectionId)),
      )
      .handle('setRepositoryConnection', ({ path, payload }) =>
        Effect.flatMap(CurrentUser, (user) =>
          service.setRepository(user, path.connectionId, path.repositoryId, payload),
        ),
      );
  }),
);
