import { HttpApiBuilder } from '@effect/platform';
import { Effect } from 'effect';
import { AppApi } from '../../contract/api.ts';
import { CurrentUser } from '../../contract/auth.ts';
import { AgentService } from './service.ts';

export const AgentsHandlers = HttpApiBuilder.group(
  AppApi,
  'agents',
  Effect.fn(function* (handlers) {
    const service = yield* AgentService;
    return handlers
      .handle('getModels', () => service.models())
      .handle('listAgents', () => Effect.flatMap(CurrentUser, service.list))
      .handle('createAgent', ({ payload }) =>
        Effect.flatMap(CurrentUser, (user) => service.create(user, payload)),
      )
      .handle('getAgent', ({ path }) =>
        Effect.flatMap(CurrentUser, (user) => service.get(user, path.agentId)),
      )
      .handle('updateAgent', ({ path, payload }) =>
        Effect.flatMap(CurrentUser, (user) => service.update(user, path.agentId, payload)),
      )
      .handle('deleteAgent', ({ path }) =>
        Effect.flatMap(CurrentUser, (user) => service.remove(user, path.agentId)),
      );
  }),
);
