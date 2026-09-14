import { HttpApiBuilder } from '@effect/platform';
import { Effect } from 'effect';
import { AppApi } from '../../contract/api.ts';
import { CurrentUser } from '../../contract/auth.ts';
import { WorkItemService } from './service.ts';

export const WorkItemsHandlers = HttpApiBuilder.group(
  AppApi,
  'workItems',
  Effect.fn(function* (handlers) {
    const service = yield* WorkItemService;
    return handlers
      .handle('listWorkItems', () => Effect.flatMap(CurrentUser, service.list))
      .handle('createWorkItem', ({ payload }) =>
        Effect.flatMap(CurrentUser, (user) => service.create(user, payload)),
      )
      .handle('getWorkItem', ({ path }) =>
        Effect.flatMap(CurrentUser, (user) => service.get(user, path.workItemId)),
      )
      .handle('updateWorkItem', ({ path, payload }) =>
        Effect.flatMap(CurrentUser, (user) => service.update(user, path.workItemId, payload)),
      )
      .handle('deleteWorkItem', ({ path }) =>
        Effect.flatMap(CurrentUser, (user) => service.remove(user, path.workItemId)),
      )
      .handle('listWorkItemFactoryRuns', ({ path }) =>
        Effect.flatMap(CurrentUser, (user) => service.listRuns(user, path.workItemId)),
      )
      .handle('listWorkItemDeliveries', ({ path }) =>
        Effect.flatMap(CurrentUser, (user) => service.listDeliveries(user, path.workItemId)),
      )
      .handle('startWorkItemFactoryRun', ({ path, payload }) =>
        Effect.flatMap(CurrentUser, (user) =>
          service.startRun(user, path.workItemId, payload.flow),
        ),
      )
      .handle('approveWorkItemPlan', ({ path, payload }) =>
        Effect.flatMap(CurrentUser, (user) =>
          service.approvePlan(user, path.workItemId, payload.artifactId),
        ),
      );
  }),
);
