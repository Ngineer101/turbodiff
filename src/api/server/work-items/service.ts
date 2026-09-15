import { Context, Effect, Layer } from 'effect';
import {
  approveWorkItemPlan,
  createWorkItem,
  deleteUnstartedWorkItem,
  getWorkItem,
  listDeliveriesForWorkItem,
  listWorkItems,
  listWorkItemTargets,
  replaceWorkItemTargets,
  updateWorkItem,
  type WorkItemRow,
  type WorkItemTargetRow,
} from '../../../data/work.ts';
import { getArtifact } from '../../../data/artifacts.ts';
import {
  artifactWasProducedForWorkItem,
  createFactoryRunWithStage,
  listFactoryRuns,
  type FactoryRunRow,
} from '../../../data/execution.ts';
import { getRepository } from '../../../data/repositories.ts';
import { DISPATCH_FLOW, PLANNING_FLOW } from '../../../application/factory/flows.ts';
import type { CurrentUserIdentity } from '../../contract/auth.ts';
import type {
  CreateWorkItem,
  UpdateWorkItem,
  WorkItem,
  WorkItemCollection,
} from '../../contract/work-items.ts';
import {
  badRequest,
  conflict,
  internalServerError,
  notFound,
  type DomainError,
} from '../../contract/errors.ts';
import { requireOrganizationWrite } from '../authorization.ts';
import { ApiDependencies } from '../context.ts';

const dataEffect = <A>(run: () => Promise<A>): Effect.Effect<A, DomainError> =>
  Effect.tryPromise({
    try: run,
    catch: (failure) => {
      console.error('turbodiff: work-item operation failed', failure);
      return internalServerError();
    },
  });

const targetsFor = (rows: WorkItemTargetRow[], workItemId: number): WorkItem['targets'] =>
  rows
    .filter((row) => row.work_item_id === workItemId)
    .map((row) => ({
      repositoryId: row.repository_id,
      owner: row.owner,
      name: row.name,
      position: row.position,
    }));

const serialize = (row: WorkItemRow, targets: WorkItemTargetRow[]): WorkItem => ({
  id: row.id,
  organizationId: row.organization_id,
  origin: row.origin,
  title: row.title,
  description: row.description,
  status: row.status,
  approvedPlanArtifactId: row.approved_plan_artifact_id,
  targets: targetsFor(targets, row.id),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  completedAt: row.completed_at,
});

const serializeRun = (run: FactoryRunRow) => ({
  id: run.id,
  flowKey: run.flow_key,
  flowVersion: run.flow_version,
  status: run.status,
  createdAt: run.created_at,
  startedAt: run.started_at,
  completedAt: run.completed_at,
});

const owned = (user: CurrentUserIdentity, id: number) =>
  dataEffect(() => getWorkItem(id)).pipe(
    Effect.flatMap((row) =>
      row && user.organizationIds.includes(row.organization_id)
        ? Effect.succeed(row)
        : Effect.fail(notFound('Unknown work item')),
    ),
  );

const validateRepositoryIds = (organizationId: string, rawIds: readonly number[]) =>
  Effect.gen(function* () {
    const ids = [...new Set(rawIds)];
    if (ids.length === 0 || ids.length > 3) {
      return yield* Effect.fail(badRequest('Choose between one and three repositories'));
    }
    const repositories = yield* dataEffect(() => Promise.all(ids.map(getRepository)));
    if (
      !repositories.every(
        (repository) => repository?.organization_id === organizationId && repository.enabled,
      )
    ) {
      return yield* Effect.fail(
        badRequest('A target repository is unknown, disabled, or belongs to another organization'),
      );
    }
    return ids;
  });

export interface WorkItemOperations {
  readonly list: (user: CurrentUserIdentity) => Effect.Effect<WorkItemCollection, DomainError>;
  readonly get: (user: CurrentUserIdentity, id: number) => Effect.Effect<WorkItem, DomainError>;
  readonly create: (
    user: CurrentUserIdentity,
    input: CreateWorkItem,
  ) => Effect.Effect<WorkItem, DomainError>;
  readonly update: (
    user: CurrentUserIdentity,
    id: number,
    input: UpdateWorkItem,
  ) => Effect.Effect<WorkItem, DomainError>;
  readonly remove: (user: CurrentUserIdentity, id: number) => Effect.Effect<void, DomainError>;
  readonly listRuns: (
    user: CurrentUserIdentity,
    id: number,
  ) => Effect.Effect<{ items: ReturnType<typeof serializeRun>[] }, DomainError>;
  readonly listDeliveries: (
    user: CurrentUserIdentity,
    id: number,
  ) => Effect.Effect<
    {
      items: Array<{
        id: number;
        repositoryId: number;
        status: 'pending' | 'active' | 'completed' | 'failed' | 'cancelled';
        createdAt: string;
        updatedAt: string;
        completedAt: string | null;
      }>;
    },
    DomainError
  >;
  readonly startRun: (
    user: CurrentUserIdentity,
    id: number,
    flow: 'planning' | 'delivery',
  ) => Effect.Effect<{ factoryRunId: number; stageRunId: number; status: 'queued' }, DomainError>;
  readonly approvePlan: (
    user: CurrentUserIdentity,
    id: number,
    artifactId: number,
  ) => Effect.Effect<{ artifactId: number; status: 'approved' }, DomainError>;
}

export class WorkItemService extends Context.Tag('Turbodiff/WorkItemService')<
  WorkItemService,
  WorkItemOperations
>() {}

export const WorkItemServiceLive = Layer.effect(
  WorkItemService,
  Effect.gen(function* () {
    const dependencies = yield* ApiDependencies;

    const load = (user: CurrentUserIdentity, id: number) =>
      Effect.gen(function* () {
        const row = yield* owned(user, id);
        const targets = yield* dataEffect(() => listWorkItemTargets([id]));
        return serialize(row, targets);
      });

    return {
      list: (user) =>
        Effect.gen(function* () {
          const rows = yield* dataEffect(() => listWorkItems(user.organizationIds));
          const targets = yield* dataEffect(() => listWorkItemTargets(rows.map((row) => row.id)));
          return { items: rows.map((row) => serialize(row, targets)) };
        }),
      get: load,
      create: (user, input) =>
        Effect.gen(function* () {
          yield* requireOrganizationWrite(user, input.organizationId);
          const title = input.title.trim().slice(0, 200);
          const description = input.description.trim();
          if (!title || !description) {
            return yield* Effect.fail(badRequest('Title and description are required'));
          }
          const repositoryIds = yield* validateRepositoryIds(
            input.organizationId,
            input.repositoryIds,
          );
          const row = yield* dataEffect(() =>
            createWorkItem({
              organizationId: input.organizationId,
              origin: input.origin ?? 'idea',
              title,
              description,
              createdByUserId: user.session.authUserId,
              repositoryIds,
            }),
          );
          return yield* load(user, row.id);
        }),
      update: (user, id, input) =>
        Effect.gen(function* () {
          const row = yield* owned(user, id);
          yield* requireOrganizationWrite(user, row.organization_id);
          const title = input.title?.trim().slice(0, 200);
          const description = input.description?.trim();
          if (input.title !== undefined && !title) {
            return yield* Effect.fail(badRequest('Title cannot be empty'));
          }
          if (input.description !== undefined && !description) {
            return yield* Effect.fail(badRequest('Description cannot be empty'));
          }
          if (input.repositoryIds !== undefined) {
            const repositoryIds = yield* validateRepositoryIds(
              row.organization_id,
              input.repositoryIds,
            );
            yield* dataEffect(() => replaceWorkItemTargets(row, repositoryIds));
          }
          yield* dataEffect(() => updateWorkItem(id, { title, description, status: input.status }));
          return yield* load(user, id);
        }),
      remove: (user, id) =>
        Effect.gen(function* () {
          const row = yield* owned(user, id);
          yield* requireOrganizationWrite(user, row.organization_id);
          if (!(yield* dataEffect(() => deleteUnstartedWorkItem(id)))) {
            return yield* Effect.fail(
              conflict('Started work items cannot be deleted; cancel them instead'),
            );
          }
        }),
      listRuns: (user, id) =>
        Effect.gen(function* () {
          const row = yield* owned(user, id);
          const runs = yield* dataEffect(() => listFactoryRuns({ workItemId: row.id }));
          return { items: runs.map(serializeRun) };
        }),
      listDeliveries: (user, id) =>
        Effect.gen(function* () {
          const row = yield* owned(user, id);
          const deliveries = yield* dataEffect(() => listDeliveriesForWorkItem(row.id));
          return {
            items: deliveries.map((delivery) => ({
              id: delivery.id,
              repositoryId: delivery.repository_id,
              status: delivery.status,
              createdAt: delivery.created_at,
              updatedAt: delivery.updated_at,
              completedAt: delivery.completed_at,
            })),
          };
        }),
      startRun: (user, id, requestedFlow) =>
        Effect.gen(function* () {
          const workItem = yield* owned(user, id);
          yield* requireOrganizationWrite(user, workItem.organization_id);
          if (workItem.status === 'completed' || workItem.status === 'cancelled') {
            return yield* Effect.fail(conflict(`Work item is ${workItem.status}`));
          }
          if (requestedFlow === 'delivery' && !workItem.approved_plan_artifact_id) {
            return yield* Effect.fail(conflict('Approve a plan artifact before delivery'));
          }
          const flow = requestedFlow === 'planning' ? PLANNING_FLOW : DISPATCH_FLOW;
          const key = `${flow.key}:${workItem.id}:${crypto.randomUUID()}`;
          const started = yield* dataEffect(() =>
            createFactoryRunWithStage(
              {
                organizationId: workItem.organization_id,
                flowKey: flow.key,
                flowVersion: flow.version,
                workItemId: workItem.id,
                trigger: 'manual',
                actorUserId: user.session.authUserId,
                idempotencyKey: key,
              },
              {
                stageKey: flow.initialStage,
                idempotencyKey: `${key}:${flow.initialStage}:1`,
              },
            ),
          );
          yield* dataEffect(() =>
            updateWorkItem(workItem.id, {
              status: requestedFlow === 'planning' ? 'planning' : 'in_progress',
            }),
          );
          yield* dataEffect(() =>
            dependencies.enqueueFactory({
              kind: 'run_factory',
              factoryRunId: started.factoryRun.id,
              stageRunId: started.stageRun.id,
            }),
          );
          return {
            factoryRunId: started.factoryRun.id,
            stageRunId: started.stageRun.id,
            status: 'queued' as const,
          };
        }),
      approvePlan: (user, id, artifactId) =>
        Effect.gen(function* () {
          const workItem = yield* owned(user, id);
          yield* requireOrganizationWrite(user, workItem.organization_id);
          const artifact = yield* dataEffect(() => getArtifact(artifactId));
          if (
            !artifact ||
            artifact.organization_id !== workItem.organization_id ||
            artifact.kind !== 'plan' ||
            !(yield* dataEffect(() => artifactWasProducedForWorkItem(artifactId, workItem.id)))
          ) {
            return yield* Effect.fail(notFound('Unknown plan artifact'));
          }
          yield* dataEffect(() => approveWorkItemPlan(workItem.id, artifact));
          return { artifactId: artifact.id, status: 'approved' as const };
        }),
    } satisfies WorkItemOperations;
  }),
);
