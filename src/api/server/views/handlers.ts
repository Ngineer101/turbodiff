import { readBoardPage } from '../../../data/board.ts';
import { HttpApiBuilder } from '@effect/platform';
import { Effect } from 'effect';
import { AppApi } from '../../contract/api.ts';
import { CurrentUser, type CurrentUserIdentity } from '../../contract/auth.ts';
import type { WorkItem } from '../../contract/work-items.ts';
import { ArtifactService } from '../artifacts/service.ts';
import { ChangeService } from '../changes/service.ts';
import { DeliveryService } from '../deliveries/service.ts';
import { WorkItemService } from '../work-items/service.ts';
import { loadFactoryRuns } from '../executions/view.ts';
import { dataEffect } from '../authorization.ts';
import { canonicalModelId, resolveModel } from '../../../data/models.ts';
import {
  latestPlanArtifactIdForWorkItem,
  latestPlanningFailureForWorkItem,
  listFactoryRuns,
} from '../../../data/execution.ts';
import { listWorkItemDeliveryViews } from '../../../data/work.ts';

// Read projections compose the existing authorized resources in one request.
export const ViewsHandlers = HttpApiBuilder.group(
  AppApi,
  'views',
  Effect.fn(function* (handlers) {
    const artifacts = yield* ArtifactService;
    const changes = yield* ChangeService;
    const deliveries = yield* DeliveryService;
    const workItems = yield* WorkItemService;
    const planFor = (user: CurrentUserIdentity, item: WorkItem) =>
      Effect.gen(function* () {
        const artifactId =
          item.approvedPlanArtifactId ??
          (yield* dataEffect(() => latestPlanArtifactIdForWorkItem(item.id)));
        return artifactId ? yield* artifacts.get(user, artifactId) : null;
      });
    const workItemView = (user: CurrentUserIdentity, item: WorkItem, defaultModel: string) =>
      Effect.gen(function* () {
        // These are task-page projections, not full delivery/execution
        // resources. Loading the latter made one task fan out into dozens of
        // redundant ownership and history queries.
        const [runs, deliveryRows, planningError] = yield* dataEffect(() =>
          Promise.all([
            listFactoryRuns({ workItemId: item.id }),
            listWorkItemDeliveryViews(item.id),
            latestPlanningFailureForWorkItem(item.id),
          ]),
        );
        return {
          workItem: item,
          deliveries: deliveryRows.map((delivery) => ({
            id: delivery.id,
            repository: {
              id: delivery.repository_id,
              owner: delivery.owner,
              name: delivery.name,
              provider: delivery.provider,
            },
            status: delivery.status,
            change: delivery.change_status
              ? { number: delivery.change_number, status: delivery.change_status }
              : null,
          })),
          plan: yield* planFor(user, item),
          factoryRuns: runs.map((run) => ({
            id: run.id,
            flowKey: run.flow_key,
            flowVersion: run.flow_version,
            status: run.status,
            createdAt: run.created_at,
            startedAt: run.started_at,
            completedAt: run.completed_at,
          })),
          planningError,
          defaultModel,
        };
      });
    return handlers
      .handle('getBoardView', ({ urlParams }) =>
        Effect.gen(function* () {
          const user = yield* CurrentUser;
          return yield* dataEffect(() => readBoardPage(user.organizationIds, urlParams));
        }),
      )
      .handle('getWorkItemView', ({ path }) =>
        Effect.gen(function* () {
          const user = yield* CurrentUser;
          const item = yield* workItems.get(user, path.workItemId);
          const model = yield* dataEffect(() => resolveModel());
          return yield* workItemView(user, item, canonicalModelId(model));
        }),
      )
      .handle('getDeliveryView', ({ path }) =>
        Effect.gen(function* () {
          const user = yield* CurrentUser;
          const delivery = yield* deliveries.get(user, path.deliveryId);
          const workItem = yield* workItems.get(user, delivery.workItemId);
          const change = delivery.change ? yield* changes.get(user, delivery.change.id) : null;
          const runs = yield* loadFactoryRuns(
            user.organizationIds,
            delivery.factoryRuns.map((run) => run.id),
          );
          return {
            delivery,
            workItem,
            change,
            revision: change?.currentRevision
              ? yield* artifacts.get(user, change.currentRevision.artifactId)
              : null,
            plan: yield* planFor(user, workItem),
            factoryRuns: runs,
          };
        }),
      );
  }),
);
