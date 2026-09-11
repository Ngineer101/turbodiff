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
      .handle('startPlanningRun', ({ path, payload }) =>
        Effect.flatMap(CurrentUser, (user) =>
          service.startPlanning(user, path.workItemId, payload),
        ),
      )
      .handle('getPlanningRun', ({ path }) =>
        Effect.flatMap(CurrentUser, (user) => service.getPlanningRun(user, path.planningRunId)),
      )
      .handle('updatePlanningRun', ({ path, payload }) =>
        Effect.flatMap(CurrentUser, (user) =>
          service.updatePlanningRun(user, path.planningRunId, payload),
        ),
      )
      .handle('answerPlanningRun', ({ path, payload }) =>
        Effect.flatMap(CurrentUser, (user) =>
          service.answerPlanningRun(user, path.planningRunId, payload.answers),
        ),
      )
      .handle('retryPlanningRun', ({ path }) =>
        Effect.flatMap(CurrentUser, (user) => service.retryPlanningRun(user, path.planningRunId)),
      )
      .handle('approvePlanningRun', ({ path }) =>
        Effect.flatMap(CurrentUser, (user) => service.approvePlanningRun(user, path.planningRunId)),
      )
      .handle('addPlanningFeedback', ({ path, payload }) =>
        Effect.flatMap(CurrentUser, (user) =>
          service.addPlanningFeedback(user, path.planningRunId, payload.comments),
        ),
      );
  }),
);
