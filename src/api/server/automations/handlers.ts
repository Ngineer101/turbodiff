import { HttpApiBuilder } from '@effect/platform';
import { Effect } from 'effect';
import { AppApi } from '../../contract/api.ts';
import { CurrentUser, type CurrentUserIdentity } from '../../contract/auth.ts';
import { AutomationService } from './service.ts';

export const AutomationsHandlers = HttpApiBuilder.group(
  AppApi,
  'automations',
  Effect.fn(function* (handlers) {
    const service = yield* AutomationService;
    const withUser = <A, E, R>(operation: (user: CurrentUserIdentity) => Effect.Effect<A, E, R>) =>
      Effect.flatMap(CurrentUser, operation);

    return handlers
      .handle('listAutomations', () => withUser(service.list))
      .handle('createAutomation', ({ payload }) =>
        withUser((user) => service.create(user, payload)),
      )
      .handle('getAutomation', ({ path }) =>
        withUser((user) => service.get(user, path.automationId)),
      )
      .handle('updateAutomation', ({ path, payload }) =>
        withUser((user) => service.update(user, path.automationId, payload)),
      )
      .handle('deleteAutomation', ({ path }) =>
        withUser((user) => service.remove(user, path.automationId)),
      )
      .handle('listAutomationRuns', ({ path }) =>
        withUser((user) => service.listRuns(user, path.automationId)),
      )
      .handle('runAutomation', ({ path }) =>
        withUser((user) => service.run(user, path.automationId)),
      )
      .handle('getAutomationRun', ({ path }) =>
        withUser((user) => service.getRun(user, path.runId)),
      );
  }),
);
