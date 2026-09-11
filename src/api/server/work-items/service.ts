import { Context, Effect, Layer } from 'effect';
import {
  createPlanForWorkItem,
  createWorkItem,
  deleteUnstartedWorkItem,
  getPlanIdForWorkItem,
  getPlanWithRepoById,
  getRepoById,
  getTaskRepoStatuses,
  getWorkItem,
  listAgentRunsForPlan,
  listPlanIdsForWorkItems,
  listWorkItems,
  listWorkItemTargets,
  replaceWorkItemTargets,
  setPlanArchived,
  setTaskRunnerModel,
  updatePlan,
  updateWorkItem,
  type PlanWithRepo,
  type WorkItemRow,
  type WorkItemTargetRow,
} from '../../../data/db.ts';
import { getRunnerModelCatalog, ModelCatalogConfigurationError } from '../../../data/models.ts';
import { approvePlan } from '../../../application/planning/approve-plan.ts';
import { parseUtc, VERIFY_STALL_AFTER_MS } from '../../../shared/time.ts';
import type { CurrentUserIdentity } from '../../contract/auth.ts';
import type {
  CreateWorkItem,
  PlanningRun,
  StartPlanningRun,
  UpdatePlanningRun,
  UpdateWorkItem,
  WorkItem,
  WorkItemCollection,
} from '../../contract/work-items.ts';
import {
  badRequest,
  conflict,
  internalServerError,
  notFound,
  serviceUnavailable,
  type DomainError,
} from '../../contract/errors.ts';
import { ApiDependencies } from '../context.ts';

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
  readonly startPlanning: (
    user: CurrentUserIdentity,
    id: number,
    input: StartPlanningRun,
  ) => Effect.Effect<{ planningRunId: number; status: 'queued' }, DomainError>;
  readonly getPlanningRun: (
    user: CurrentUserIdentity,
    id: number,
  ) => Effect.Effect<PlanningRun, DomainError>;
  readonly updatePlanningRun: (
    user: CurrentUserIdentity,
    id: number,
    input: UpdatePlanningRun,
  ) => Effect.Effect<PlanningRun, DomainError>;
  readonly answerPlanningRun: (
    user: CurrentUserIdentity,
    id: number,
    answers: readonly string[],
  ) => Effect.Effect<{ status: 'queued' }, DomainError>;
  readonly retryPlanningRun: (
    user: CurrentUserIdentity,
    id: number,
  ) => Effect.Effect<{ status: 'queued' }, DomainError>;
  readonly approvePlanningRun: (
    user: CurrentUserIdentity,
    id: number,
  ) => Effect.Effect<{ status: 'queued'; deliveryIds: number[] }, DomainError>;
  readonly addPlanningFeedback: (
    user: CurrentUserIdentity,
    id: number,
    comments: readonly { readonly snippet?: string; readonly comment: string }[],
  ) => Effect.Effect<{ status: 'queued' }, DomainError>;
}

export class WorkItemService extends Context.Tag('Turbodiff/WorkItemService')<
  WorkItemService,
  WorkItemOperations
>() {}

const dataEffect = <A>(operation: () => Promise<A>): Effect.Effect<A, DomainError> =>
  Effect.tryPromise({
    try: operation,
    catch: (error) => {
      if (error instanceof ModelCatalogConfigurationError) {
        return serviceUnavailable(error.message);
      }
      console.error('turbodiff: Effect work-item operation failed', error);
      return internalServerError();
    },
  });

const targetsFor = (targets: WorkItemTargetRow[], workItemId: number): WorkItem['targets'] =>
  targets
    .filter((target) => target.work_item_id === workItemId)
    .map((target) => ({
      repositoryId: target.repository_id,
      owner: target.owner,
      name: target.name,
      provider: target.provider,
      enabled: target.enabled,
    }));

const serializeWorkItem = (
  row: WorkItemRow,
  targets: WorkItemTargetRow[],
  planningRunId: number | null,
): WorkItem => ({
  id: row.id,
  installationId: row.installation_id,
  origin: row.origin,
  title: row.title,
  description: row.description,
  status: row.status,
  runnerModel: row.runner_model,
  planningRunId,
  targets: targetsFor(targets, row.id),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const ensureOwned = (user: CurrentUserIdentity, row: WorkItemRow | null) =>
  row && user.installationIds.includes(row.installation_id)
    ? Effect.succeed(row)
    : Effect.fail(notFound('Unknown work item'));

const validRepositoryIds = (
  installationId: number,
  repositoryIds: readonly number[],
): Effect.Effect<number[], DomainError> => {
  const ids = [...new Set(repositoryIds)];
  if (ids.length === 0 || ids.length > 3) {
    return Effect.fail(badRequest('Choose between one and three repositories'));
  }
  return dataEffect(() => Promise.all(ids.map((id) => getRepoById(id)))).pipe(
    Effect.flatMap((repositories) =>
      repositories.every(
        (repository) => repository?.installation_id === installationId && repository.enabled,
      )
        ? Effect.succeed(ids)
        : Effect.fail(
            badRequest('A target repository is unknown, disabled, or in another installation'),
          ),
    ),
  );
};

function serializePlanningRun(
  plan: PlanWithRepo,
  targets: Awaited<ReturnType<typeof getTaskRepoStatuses>>,
  agentRuns: Awaited<ReturnType<typeof listAgentRunsForPlan>>,
): PlanningRun {
  if (!plan.runner_model) {
    throw new ModelCatalogConfigurationError(`Planning run ${plan.id} has no model snapshot`);
  }
  return {
    id: plan.id,
    workItemId: plan.work_item_id,
    title: plan.title,
    status: plan.status,
    error: plan.error,
    questions: plan.questions ?? [],
    acceptance: plan.acceptance ?? [],
    plan: plan.plan,
    summary: plan.summary,
    archived: plan.archived,
    model: plan.runner_model,
    attachments: (plan.attachments ?? []).map((attachment) => ({ name: attachment.name })),
    targets: targets.map((target) => ({
      repositoryId: target.repository_id,
      owner: target.owner,
      name: target.name,
      provider: target.provider,
      deliveryId: target.feature_id,
      changeId: target.change_id,
      pullRequestNumber: target.pr_number,
      status: target.feature_status,
      error: target.feature_error,
      verification: target.verification_status
        ? {
            status:
              target.verification_status === 'running' &&
              target.verification_created_at !== null &&
              Date.now() - parseUtc(target.verification_created_at) > VERIFY_STALL_AFTER_MS
                ? 'stalled'
                : target.verification_status,
            total: (target.verification_results ?? []).length,
            failed: (target.verification_results ?? []).filter(
              (result) => result.verdict === 'fail',
            ).length,
          }
        : null,
    })),
    agentRuns: agentRuns.map((run) => ({
      id: run.id,
      kind: run.kind,
      success: run.success,
      createdAt: run.created_at,
    })),
    createdAt: plan.created_at,
  };
}

export const WorkItemServiceLive = Layer.effect(
  WorkItemService,
  Effect.gen(function* () {
    const dependencies = yield* ApiDependencies;

    const loadOne = (user: CurrentUserIdentity, id: number) =>
      Effect.gen(function* () {
        const row = yield* dataEffect(() => getWorkItem(id));
        const owned = yield* ensureOwned(user, row);
        const [targets, planningRunId] = yield* dataEffect(() =>
          Promise.all([listWorkItemTargets([id]), getPlanIdForWorkItem(id)]),
        );
        return serializeWorkItem(owned, targets, planningRunId);
      });

    const ownedPlan = (user: CurrentUserIdentity, id: number) =>
      dataEffect(() => getPlanWithRepoById(id)).pipe(
        Effect.flatMap((plan) =>
          plan && user.installationIds.includes(plan.installation_id)
            ? Effect.succeed(plan)
            : Effect.fail(notFound('Unknown planning run')),
        ),
      );

    const loadPlanningRun = (user: CurrentUserIdentity, id: number) =>
      Effect.gen(function* () {
        const plan = yield* ownedPlan(user, id);
        const [targets, agentRuns] = yield* dataEffect(() =>
          Promise.all([getTaskRepoStatuses([plan.id]), listAgentRunsForPlan(plan.id)]),
        );
        return serializePlanningRun(plan, targets, agentRuns);
      });

    return {
      list: (user) =>
        Effect.gen(function* () {
          const rows = yield* dataEffect(() => listWorkItems(user.installationIds));
          const ids = rows.map((row) => row.id);
          const [targets, plans] = yield* dataEffect(() =>
            Promise.all([listWorkItemTargets(ids), listPlanIdsForWorkItems(ids)]),
          );
          const plansByWorkItem = new Map(plans.map((plan) => [plan.work_item_id, plan.id]));
          return {
            items: rows.map((row) =>
              serializeWorkItem(row, targets, plansByWorkItem.get(row.id) ?? null),
            ),
          };
        }),
      get: loadOne,
      create: (user, input) =>
        Effect.gen(function* () {
          if (!user.installationIds.includes(input.installationId)) {
            return yield* Effect.fail(notFound('Unknown installation'));
          }
          const title = input.title.trim().slice(0, 200);
          const description = input.description.trim();
          if (!title) return yield* Effect.fail(badRequest('Title is required'));
          if (!description) return yield* Effect.fail(badRequest('Description is required'));
          const repositoryIds = yield* validRepositoryIds(
            input.installationId,
            input.repositoryIds,
          );
          const catalog = yield* dataEffect(getRunnerModelCatalog);
          const runnerModel = input.runnerModel?.trim() || catalog.defaultModel;
          if (!catalog.options.some((option) => option.id === runnerModel)) {
            return yield* Effect.fail(badRequest('Unknown model'));
          }
          const origin = input.origin ?? 'idea';
          if (origin !== 'idea' && origin !== 'api') {
            return yield* Effect.fail(badRequest('User-created work must have idea or api origin'));
          }
          const row = yield* dataEffect(() =>
            createWorkItem({
              installationId: input.installationId,
              repositoryIds,
              title,
              description,
              origin,
              createdBy: { login: user.session.login, id: user.session.userId },
              runnerModel,
            }),
          );
          return yield* loadOne(user, row.id);
        }),
      update: (user, id, input) =>
        Effect.gen(function* () {
          const row = yield* dataEffect(() => getWorkItem(id));
          const owned = yield* ensureOwned(user, row);
          const title = input.title?.trim().slice(0, 200);
          const description = input.description?.trim();
          if (input.title !== undefined && !title) {
            return yield* Effect.fail(badRequest('Title cannot be empty'));
          }
          if (input.description !== undefined && !description) {
            return yield* Effect.fail(badRequest('Description cannot be empty'));
          }
          if (input.runnerModel !== undefined) {
            const catalog = yield* dataEffect(getRunnerModelCatalog);
            if (!catalog.options.some((option) => option.id === input.runnerModel?.trim())) {
              return yield* Effect.fail(badRequest('Unknown model'));
            }
          }
          if (input.repositoryIds !== undefined) {
            const repositoryIds = yield* validRepositoryIds(
              owned.installation_id,
              input.repositoryIds,
            );
            const replaced = yield* dataEffect(() => replaceWorkItemTargets(id, repositoryIds));
            if (!replaced) {
              return yield* Effect.fail(conflict('Targets are immutable after planning starts'));
            }
          }
          const changes: Parameters<typeof updateWorkItem>[1] = {};
          if (title !== undefined) changes.title = title;
          if (description !== undefined) changes.description = description;
          if (input.status !== undefined) changes.status = input.status;
          if (input.runnerModel !== undefined) changes.runnerModel = input.runnerModel.trim();
          const updated = yield* dataEffect(() => updateWorkItem(id, changes));
          if (!updated) return yield* Effect.fail(notFound('Unknown work item'));
          const planId = yield* dataEffect(() => getPlanIdForWorkItem(id));
          if (planId && input.runnerModel !== undefined) {
            yield* dataEffect(() => setTaskRunnerModel(planId, input.runnerModel!.trim()));
          }
          return yield* loadOne(user, id);
        }),
      remove: (user, id) =>
        Effect.gen(function* () {
          yield* ensureOwned(user, yield* dataEffect(() => getWorkItem(id)));
          const deleted = yield* dataEffect(() => deleteUnstartedWorkItem(id));
          if (!deleted) {
            return yield* Effect.fail(
              conflict('Started work items cannot be deleted; close them instead'),
            );
          }
        }),
      startPlanning: (user, id, input) =>
        Effect.gen(function* () {
          const row = yield* ensureOwned(user, yield* dataEffect(() => getWorkItem(id)));
          if (row.status !== 'open') return yield* Effect.fail(conflict('Work item is closed'));
          const requirements = input.requirements?.trim() || row.description;
          const title = input.title?.trim().slice(0, 200) || row.title;
          const catalog = yield* dataEffect(getRunnerModelCatalog);
          const model = input.model?.trim() || row.runner_model || catalog.defaultModel;
          if (!catalog.options.some((option) => option.id === model)) {
            return yield* Effect.fail(badRequest('Unknown model'));
          }
          const attachments = (input.attachments ?? [])
            .filter((attachment) => attachment.key.startsWith('plan-uploads/'))
            .slice(0, 5)
            .map((attachment) => ({
              key: attachment.key,
              name: attachment.name.slice(-120),
              content_type: attachment.contentType,
            }));
          const planningInput: Parameters<typeof createPlanForWorkItem>[0] = {
            workItemId: id,
            title,
            requirements,
            createdBy: { login: user.session.login, id: user.session.userId },
            runnerModel: model,
          };
          if (attachments.length > 0) planningInput.attachments = attachments;
          const started = yield* dataEffect(() => createPlanForWorkItem(planningInput));
          if (!started) return yield* Effect.fail(conflict('Work item cannot be started'));
          if (started.created) {
            yield* dataEffect(() =>
              dependencies.enqueueFactory({ kind: 'plan_analyze', planId: started.planId }),
            );
          }
          return { planningRunId: started.planId, status: 'queued' as const };
        }),
      getPlanningRun: loadPlanningRun,
      updatePlanningRun: (user, id, input) =>
        Effect.gen(function* () {
          yield* ownedPlan(user, id);
          if (input.model !== undefined) {
            const model = input.model.trim();
            const catalog = yield* dataEffect(getRunnerModelCatalog);
            if (!catalog.options.some((option) => option.id === model)) {
              return yield* Effect.fail(badRequest('Unknown model'));
            }
            yield* dataEffect(() => setTaskRunnerModel(id, model));
          }
          if (input.archived !== undefined) {
            yield* dataEffect(() => setPlanArchived(id, input.archived!));
          }
          return yield* loadPlanningRun(user, id);
        }),
      answerPlanningRun: (user, id, answers) =>
        Effect.gen(function* () {
          const plan = yield* ownedPlan(user, id);
          if (plan.status !== 'awaiting_answers') {
            return yield* Effect.fail(
              conflict(`Planning run is ${plan.status}, not awaiting answers`),
            );
          }
          const normalized = (plan.questions ?? []).map((_, index) => answers[index] ?? '');
          yield* dataEffect(() => updatePlan(id, { status: 'refining', answers: normalized }));
          yield* dataEffect(() => dependencies.enqueueFactory({ kind: 'plan_refine', planId: id }));
          return { status: 'queued' as const };
        }),
      retryPlanningRun: (user, id) =>
        Effect.gen(function* () {
          const plan = yield* ownedPlan(user, id);
          if (plan.status !== 'failed') {
            return yield* Effect.fail(conflict(`Planning run is ${plan.status}, not retryable`));
          }
          let hasFeedback = false;
          try {
            hasFeedback = plan.feedback ? JSON.parse(plan.feedback).length > 0 : false;
          } catch {
            hasFeedback = false;
          }
          const refine = plan.answers !== null || hasFeedback;
          yield* dataEffect(() => updatePlan(id, { status: refine ? 'refining' : 'analyzing' }));
          yield* dataEffect(() =>
            dependencies.enqueueFactory(
              refine ? { kind: 'plan_refine', planId: id } : { kind: 'plan_analyze', planId: id },
            ),
          );
          return { status: 'queued' as const };
        }),
      approvePlanningRun: (user, id) =>
        Effect.gen(function* () {
          yield* ownedPlan(user, id);
          const deliveryIds = yield* dataEffect(() =>
            approvePlan(id, { login: user.session.login, id: user.session.userId }),
          );
          if (!deliveryIds) {
            return yield* Effect.fail(conflict('Planning run is not ready for approval'));
          }
          yield* dataEffect(() =>
            Promise.all(
              deliveryIds.map((featureId) =>
                dependencies.enqueueFactory({ kind: 'generate', featureId }),
              ),
            ).then(() => undefined),
          );
          return { status: 'queued' as const, deliveryIds };
        }),
      addPlanningFeedback: (user, id, input) =>
        Effect.gen(function* () {
          const plan = yield* ownedPlan(user, id);
          if (plan.status !== 'plan_ready') {
            return yield* Effect.fail(
              conflict(`Planning run is ${plan.status}, not ready for feedback`),
            );
          }
          const comments = input
            .map((item) => ({
              snippet: item.snippet?.trim().slice(0, 300) ?? '',
              comment: item.comment.trim().slice(0, 1000),
            }))
            .filter((item) => item.comment)
            .slice(0, 20);
          if (comments.length === 0) {
            return yield* Effect.fail(badRequest('At least one comment is required'));
          }
          yield* dataEffect(() =>
            updatePlan(id, {
              status: 'refining',
              feedback: JSON.stringify(comments),
            }),
          );
          yield* dataEffect(() => dependencies.enqueueFactory({ kind: 'plan_refine', planId: id }));
          return { status: 'queued' as const };
        }),
    } satisfies WorkItemOperations;
  }),
);
