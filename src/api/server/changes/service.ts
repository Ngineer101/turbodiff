import { Context, Effect, Layer } from 'effect';
import {
  getChange,
  getFactoryRun,
  getRepoById,
  listLifecycleEvents,
  listStageRuns,
  listChangesForRepo,
  type ChangeRow,
  type ChangeStatus,
} from '../../../data/db.ts';
import { capabilityDenied } from '../../../application/auth/access-control.ts';
import { scheduleChangeReview } from '../../../application/factory/lifecycle.ts';
import type { CurrentUserIdentity } from '../../contract/auth.ts';
import type { Change, ReviewRun } from '../../contract/changes.ts';
import {
  conflict,
  forbidden,
  internalServerError,
  notFound,
  type DomainError,
} from '../../contract/errors.ts';
import { ApiDependencies } from '../context.ts';

export interface ChangeOperations {
  readonly list: (
    user: CurrentUserIdentity,
    repositoryId: number,
    status?: ChangeStatus,
  ) => Effect.Effect<{ items: Change[] }, DomainError>;
  readonly get: (user: CurrentUserIdentity, id: number) => Effect.Effect<Change, DomainError>;
  readonly createReviewRun: (
    user: CurrentUserIdentity,
    id: number,
  ) => Effect.Effect<
    { reviewRunId: number; stageRunId: number | null; status: 'queued' },
    DomainError
  >;
  readonly getReviewRun: (
    user: CurrentUserIdentity,
    id: number,
  ) => Effect.Effect<ReviewRun, DomainError>;
}

export class ChangeService extends Context.Tag('Turbodiff/ChangeService')<
  ChangeService,
  ChangeOperations
>() {}

const dataEffect = <A>(operation: () => Promise<A>): Effect.Effect<A, DomainError> =>
  Effect.tryPromise({
    try: operation,
    catch: (error) => {
      console.error('turbodiff: Effect change operation failed', error);
      return internalServerError();
    },
  });

const serialize = (change: ChangeRow): Change => ({
  id: change.id,
  repositoryId: change.repository_id,
  providerKey: change.provider_key,
  number: change.number,
  origin: change.origin,
  title: change.title,
  externalUrl: change.external_url,
  sourceBranch: change.source_branch,
  targetBranch: change.target_branch,
  status: change.status,
  sourceHead: change.source_head,
  targetHead: change.target_head,
  draft: change.draft,
  capabilities: change.capabilities,
  providerUpdatedAt: change.provider_updated_at,
  createdAt: change.created_at,
  updatedAt: change.updated_at,
});

export const ChangeServiceLive = Layer.effect(
  ChangeService,
  Effect.gen(function* () {
    const dependencies = yield* ApiDependencies;

    const authorizedRepository = (user: CurrentUserIdentity, id: number) =>
      dataEffect(() => getRepoById(id)).pipe(
        Effect.flatMap((repository) =>
          repository && user.installationIds.includes(repository.installation_id)
            ? Effect.succeed(repository)
            : Effect.fail(notFound('Unknown repository')),
        ),
      );

    const authorizedChange = (user: CurrentUserIdentity, id: number) =>
      dataEffect(() => getChange(id)).pipe(
        Effect.flatMap((change) =>
          change
            ? authorizedRepository(user, change.repository_id).pipe(Effect.as(change))
            : Effect.fail(notFound('Unknown change')),
        ),
      );

    return {
      list: (user, repositoryId, status) =>
        Effect.gen(function* () {
          yield* authorizedRepository(user, repositoryId);
          const items = yield* dataEffect(() => listChangesForRepo(repositoryId, status));
          return { items: items.map(serialize) };
        }),
      get: (user, id) => authorizedChange(user, id).pipe(Effect.map(serialize)),
      createReviewRun: (user, id) =>
        Effect.gen(function* () {
          const change = yield* authorizedChange(user, id);
          const repository = yield* authorizedRepository(user, change.repository_id);
          const denial = yield* dataEffect(() =>
            capabilityDenied(user, repository.installation_id, 'settings', dependencies.orgAdmin),
          );
          if (denial) return yield* Effect.fail(forbidden(denial));
          const scheduled = yield* dataEffect(() =>
            scheduleChangeReview({
              changeId: id,
              trigger: 'manual',
              actor: user.session.login,
              idempotencyKey: `manual-review:${id}:${crypto.randomUUID()}`,
              enqueue: dependencies.enqueueFactory,
            }),
          );
          if (scheduled.decision.kind !== 'schedule') {
            const reason =
              'reason' in scheduled.decision
                ? scheduled.decision.reason
                : 'Review was not scheduled';
            return yield* Effect.fail(conflict(reason));
          }
          return {
            reviewRunId: scheduled.runId,
            stageRunId: scheduled.stageRunId,
            status: 'queued' as const,
          };
        }),
      getReviewRun: (user, id) =>
        Effect.gen(function* () {
          const run = yield* dataEffect(() => getFactoryRun(id));
          if (!run) return yield* Effect.fail(notFound('Unknown review run'));
          yield* authorizedRepository(user, run.repository_id);
          const [stages, events] = yield* dataEffect(() =>
            Promise.all([listStageRuns(id), listLifecycleEvents(id)]),
          );
          return {
            id: run.id,
            changeId: run.change_id,
            profile: run.profile_key,
            status: run.status,
            startStage: run.start_stage,
            stopAfterStage: run.stop_after_stage,
            handoffReason: run.handoff_reason,
            stages: stages.map((stage) => ({
              id: stage.id,
              stage: stage.stage,
              attempt: stage.attempt,
              status: stage.status,
              error: stage.error,
              startedAt: stage.started_at,
              completedAt: stage.completed_at,
            })),
            events: events.map((event) => ({
              key: event.idempotency_key,
              kind: event.kind,
              decision: event.decision?.kind ?? null,
              createdAt: event.created_at,
            })),
            createdAt: run.created_at,
            completedAt: run.completed_at,
          };
        }),
    } satisfies ChangeOperations;
  }),
);
