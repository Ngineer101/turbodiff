import { readBoardPage } from '../../../data/board.ts';
import { HttpApiBuilder } from '@effect/platform';
import { Effect } from 'effect';
import { AppApi } from '../../contract/api.ts';
import { CurrentUser, type CurrentUserIdentity } from '../../contract/auth.ts';
import type { WorkItem } from '../../contract/work-items.ts';
import type { FactoryRun } from '../../contract/executions.ts';
import { ArtifactService } from '../artifacts/service.ts';
import { ChangeService } from '../changes/service.ts';
import { DeliveryService } from '../deliveries/service.ts';
import { WorkItemService } from '../work-items/service.ts';
import { loadFactoryRun } from '../executions/view.ts';
import { dataEffect } from '../authorization.ts';
import { canonicalModelId, resolveModel } from '../../../data/models.ts';

// Read projections compose the existing authorized resources in one request.
export const ViewsHandlers = HttpApiBuilder.group(
  AppApi,
  'views',
  Effect.fn(function* (handlers) {
    const artifacts = yield* ArtifactService;
    const changes = yield* ChangeService;
    const deliveries = yield* DeliveryService;
    const workItems = yield* WorkItemService;
    const runsForWorkItem = (user: CurrentUserIdentity, id: number) =>
      workItems
        .listRuns(user, id)
        .pipe(
          Effect.flatMap(({ items }) =>
            Effect.forEach(items, (run) => loadFactoryRun(user.organizationIds, run.id)),
          ),
        );
    const planFor = (user: CurrentUserIdentity, item: WorkItem, runs: readonly FactoryRun[]) => {
      const artifactId =
        item.approvedPlanArtifactId ??
        runs
          .filter((run) => run.flowKey === 'work_item')
          .flatMap((run) => run.stages.filter((stage) => stage.stageKey === 'plan'))
          .flatMap((stage) => stage.agentRuns)
          .find((run) => run.status === 'succeeded' && run.outputArtifactId)?.outputArtifactId;
      return artifactId ? artifacts.get(user, artifactId) : Effect.succeed(null);
    };
    const workItemView = (user: CurrentUserIdentity, item: WorkItem, defaultModel: string) =>
      Effect.gen(function* () {
        const runs = yield* runsForWorkItem(user, item.id);
        const deliveryList = yield* workItems.listDeliveries(user, item.id);
        return {
          workItem: item,
          deliveries: yield* Effect.forEach(deliveryList.items, (delivery) =>
            deliveries.get(user, delivery.id),
          ),
          plan: yield* planFor(user, item, runs),
          factoryRuns: runs,
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
          const runs = yield* Effect.forEach(delivery.factoryRuns, (run) =>
            loadFactoryRun(user.organizationIds, run.id),
          );
          const planningRuns = workItem.approvedPlanArtifactId
            ? []
            : yield* runsForWorkItem(user, workItem.id);
          return {
            delivery,
            workItem,
            change,
            revision: change?.currentRevision
              ? yield* artifacts.get(user, change.currentRevision.artifactId)
              : null,
            plan: yield* planFor(user, workItem, planningRuns),
            factoryRuns: runs,
          };
        }),
      );
  }),
);
