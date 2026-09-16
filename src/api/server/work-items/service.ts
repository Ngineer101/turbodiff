import { Context, Effect, Layer } from 'effect';
import {
  approveWorkItemPlan,
  createWorkItem,
  deleteUnstartedWorkItem,
  getWorkItem,
  listDeliveriesForWorkItem,
  listWorkItemAttachments,
  listWorkItems,
  listWorkItemTargets,
  replaceWorkItemTargets,
  updateWorkItem,
  type WorkItemRow,
  type WorkItemTargetRow,
  type WorkItemAttachmentRow,
} from '../../../data/work.ts';
import { getArtifact } from '../../../data/artifacts.ts';
import {
  createFactoryRunWithStage,
  findWaitingRunForWorkItemPlan,
  listFactoryRuns,
  recordLifecycleEvent,
  resumeFactoryRunAtStage,
  type FactoryRunRow,
} from '../../../data/execution.ts';
import { getRepository } from '../../../data/repositories.ts';
import { WORK_ITEM_FLOW } from '../../../application/factory/flows.ts';
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
import { resolveModel } from '../../../data/models.ts';

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

const serialize = (
  row: WorkItemRow,
  targets: WorkItemTargetRow[],
  attachments: WorkItemAttachmentRow[],
): WorkItem => ({
  id: row.id,
  organizationId: row.organization_id,
  origin: row.origin,
  title: row.title,
  description: row.description,
  status: row.status,
  approvedPlanArtifactId: row.approved_plan_artifact_id,
  attachments: attachments
    .filter((attachment) => attachment.work_item_id === row.id)
    .map((attachment) => ({ artifactId: attachment.artifact_id, name: attachment.name })),
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
    if (ids.length > 3) {
      return yield* Effect.fail(badRequest('Choose no more than three repositories'));
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
    model?: string,
    attachments?: ReadonlyArray<{ readonly artifactId: number; readonly name: string }>,
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
        const [targets, attachments] = yield* dataEffect(() =>
          Promise.all([listWorkItemTargets([id]), listWorkItemAttachments([id])]),
        );
        return serialize(row, targets, attachments);
      });

    return {
      list: (user) =>
        Effect.gen(function* () {
          const rows = yield* dataEffect(() => listWorkItems(user.organizationIds));
          const ids = rows.map((row) => row.id);
          const [targets, attachments] = yield* dataEffect(() =>
            Promise.all([listWorkItemTargets(ids), listWorkItemAttachments(ids)]),
          );
          return { items: rows.map((row) => serialize(row, targets, attachments)) };
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
      startRun: (user, id, requestedFlow, requestedModel, requestedAttachments = []) =>
        Effect.gen(function* () {
          const workItem = yield* owned(user, id);
          yield* requireOrganizationWrite(user, workItem.organization_id);
          if (workItem.status === 'completed' || workItem.status === 'cancelled') {
            return yield* Effect.fail(conflict(`Work item is ${workItem.status}`));
          }
          if (requestedFlow === 'delivery' && !workItem.approved_plan_artifact_id) {
            return yield* Effect.fail(conflict('Approve a plan artifact before delivery'));
          }
          if (requestedFlow !== 'planning' && requestedAttachments.length > 0) {
            return yield* Effect.fail(badRequest('Attachments are only accepted for planning'));
          }
          if (requestedAttachments.length > 5) {
            return yield* Effect.fail(badRequest('At most five attachments are allowed'));
          }
          const targets = yield* dataEffect(() => listWorkItemTargets([workItem.id]));
          if (targets.length === 0) {
            return yield* Effect.fail(
              badRequest('Choose between one and three repositories before starting'),
            );
          }
          yield* validateRepositoryIds(
            workItem.organization_id,
            targets.map((target) => target.repository_id),
          );
          const attachments = yield* Effect.forEach(requestedAttachments, (attachment) =>
            dataEffect(() => getArtifact(attachment.artifactId)).pipe(
              Effect.flatMap((artifact) =>
                artifact?.organization_id === workItem.organization_id &&
                artifact.kind === 'work_item_attachment'
                  ? Effect.succeed({
                      artifactId: artifact.id,
                      name: attachment.name.trim().slice(-120) || 'attachment',
                    })
                  : Effect.fail(notFound('Unknown attachment artifact')),
              ),
            ),
          );
          const planningStage = WORK_ITEM_FLOW.stages[WORK_ITEM_FLOW.initialStage];
          const stageKey =
            requestedFlow === 'planning'
              ? WORK_ITEM_FLOW.initialStage
              : planningStage.success.nextStage;
          const model = yield* dataEffect(() => resolveModel(requestedModel));
          const key = `${WORK_ITEM_FLOW.key}:${workItem.id}:${crypto.randomUUID()}`;
          const started = yield* dataEffect(() =>
            createFactoryRunWithStage(
              {
                organizationId: workItem.organization_id,
                flowKey: WORK_ITEM_FLOW.key,
                flowVersion: WORK_ITEM_FLOW.version,
                modelId: model.id,
                workItemId: workItem.id,
                trigger: 'manual',
                actorUserId: user.session.authUserId,
                idempotencyKey: key,
              },
              {
                stageKey,
                idempotencyKey: `${key}:${stageKey}:1`,
              },
            ),
          );
          yield* dataEffect(() =>
            updateWorkItem(workItem.id, {
              status: requestedFlow === 'planning' ? 'planning' : 'in_progress',
            }),
          );
          yield* dataEffect(() =>
            recordLifecycleEvent({
              organizationId: workItem.organization_id,
              factoryRunId: started.factoryRun.id,
              stageRunId: started.stageRun.id,
              kind: 'factory_run_requested',
              payload: { attachments },
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
            artifact.kind !== 'plan'
          ) {
            return yield* Effect.fail(notFound('Unknown plan artifact'));
          }
          const waiting = yield* dataEffect(() =>
            findWaitingRunForWorkItemPlan(workItem.id, artifactId, {
              flowKey: WORK_ITEM_FLOW.key,
              flowVersion: WORK_ITEM_FLOW.version,
              stageKey: WORK_ITEM_FLOW.initialStage,
            }),
          );
          if (!waiting) return yield* Effect.fail(conflict('The plan is not awaiting approval'));
          const transition = WORK_ITEM_FLOW.stages[WORK_ITEM_FLOW.initialStage].success;
          yield* dataEffect(() => approveWorkItemPlan(workItem.id, artifact));
          const nextStage = yield* dataEffect(() =>
            resumeFactoryRunAtStage({
              factoryRunId: waiting.factoryRun.id,
              waitingStageRunId: waiting.stageRun.id,
              nextStageKey: transition.nextStage,
              gate: transition.gate,
            }),
          );
          yield* dataEffect(() =>
            dependencies.enqueueFactory({
              kind: 'run_factory',
              factoryRunId: waiting.factoryRun.id,
              stageRunId: nextStage.id,
            }),
          );
          return { artifactId: artifact.id, status: 'approved' as const };
        }),
    } satisfies WorkItemOperations;
  }),
);
