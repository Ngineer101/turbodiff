import { HttpApiBuilder } from '@effect/platform';
import { Effect } from 'effect';
import { AppApi } from '../../contract/api.ts';
import { CurrentUser } from '../../contract/auth.ts';
import { IntegrationService } from './service.ts';

export const IntegrationsHandlers = HttpApiBuilder.group(
  AppApi,
  'integrations',
  Effect.fn(function* (handlers) {
    const service = yield* IntegrationService;
    return handlers
      .handle('listIntegrations', () => Effect.flatMap(CurrentUser, service.list))
      .handle('getIntegration', ({ path }) =>
        Effect.flatMap(CurrentUser, (user) => service.get(user, path.integrationId)),
      )
      .handle('createIntegration', ({ payload }) =>
        Effect.flatMap(CurrentUser, (user) => service.create(user, payload)),
      )
      .handle('updateIntegration', ({ path, payload }) =>
        Effect.flatMap(CurrentUser, (user) => service.update(user, path.integrationId, payload)),
      )
      .handle('deleteIntegration', ({ path }) =>
        Effect.flatMap(CurrentUser, (user) => service.remove(user, path.integrationId)),
      );
  }),
);
