import { Context, Effect, Layer } from 'effect';
import {
  createFactoryRunWithStage,
  getChange,
  getRepository,
  latestChangeRevision,
  listChangesForRepository,
  listReviewOutcomes,
  type ChangeRevisionRow,
  type ChangeRow,
  type ReviewOutcomeRow,
} from '../../../data/db.ts';
import { REVIEW_FLOW } from '../../../application/factory/flows.ts';
import type { CurrentUserIdentity } from '../../contract/auth.ts';
import type { Change, ChangeCollection } from '../../contract/changes.ts';
import {
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
      console.error('turbodiff: change operation failed', failure);
      return internalServerError();
    },
  });

const serializeRevision = (revision: ChangeRevisionRow | null, outcomes: ReviewOutcomeRow[]) =>
  revision
    ? {
        id: revision.id,
        version: revision.version,
        baseSha: revision.base_sha,
        headSha: revision.head_sha,
        artifactId: revision.artifact_id,
        reviewOutcomes: outcomes.map((outcome) => ({
          agentRunId: outcome.agent_run_id,
          verdict: outcome.verdict,
          conclusion: outcome.conclusion,
          coverageStatus: outcome.coverage_status,
          findingCount: outcome.finding_count,
          publicationUrl: outcome.publication_url,
          publishedAt: outcome.published_at,
        })),
        createdAt: revision.created_at,
      }
    : null;

const serialize = (
  change: ChangeRow,
  revision: ChangeRevisionRow | null,
  outcomes: ReviewOutcomeRow[],
): Change => ({
  id: change.id,
  organizationId: change.organization_id,
  repositoryId: change.repository_id,
  deliveryId: change.delivery_id,
  providerIntegrationId: change.provider_integration_id,
  providerKey: change.provider_key,
  number: change.number,
  title: change.title,
  sourceRef: change.source_ref,
  targetRef: change.target_ref,
  url: change.url,
  origin: change.origin,
  status: change.status,
  currentRevision: serializeRevision(revision, outcomes),
  createdAt: change.created_at,
  updatedAt: change.updated_at,
});

const owned = (user: CurrentUserIdentity, id: number) =>
  dataEffect(() => getChange(id)).pipe(
    Effect.flatMap((change) =>
      change && user.organizationIds.includes(change.organization_id)
        ? Effect.succeed(change)
        : Effect.fail(notFound('Unknown change')),
    ),
  );

export interface ChangeOperations {
  readonly list: (
    user: CurrentUserIdentity,
    repositoryId: number,
    status?: 'open' | 'merged' | 'closed',
  ) => Effect.Effect<typeof ChangeCollection.Type, DomainError>;
  readonly get: (user: CurrentUserIdentity, id: number) => Effect.Effect<Change, DomainError>;
  readonly createReviewRun: (
    user: CurrentUserIdentity,
    id: number,
  ) => Effect.Effect<{ factoryRunId: number; stageRunId: number; status: 'queued' }, DomainError>;
}

export class ChangeService extends Context.Tag('Turbodiff/ChangeService')<
  ChangeService,
  ChangeOperations
>() {}

export const ChangeServiceLive = Layer.effect(
  ChangeService,
  Effect.gen(function* () {
    const dependencies = yield* ApiDependencies;
    return {
      list: (user, repositoryId, status) =>
        Effect.gen(function* () {
          const repository = yield* dataEffect(() => getRepository(repositoryId));
          if (!repository || !user.organizationIds.includes(repository.organization_id)) {
            return yield* Effect.fail(notFound('Unknown repository'));
          }
          const rows = (yield* dataEffect(() => listChangesForRepository(repositoryId))).filter(
            (change) => !status || change.status === status,
          );
          const revisions = yield* dataEffect(() =>
            Promise.all(rows.map((change) => latestChangeRevision(change.id))),
          );
          const outcomes = yield* dataEffect(() =>
            Promise.all(
              revisions.map((revision) =>
                revision ? listReviewOutcomes(revision.id) : Promise.resolve([]),
              ),
            ),
          );
          return {
            items: rows.map((change, index) =>
              serialize(change, revisions[index] ?? null, outcomes[index] ?? []),
            ),
          };
        }),
      get: (user, id) =>
        Effect.gen(function* () {
          const change = yield* owned(user, id);
          const revision = yield* dataEffect(() => latestChangeRevision(id));
          const outcomes = revision ? yield* dataEffect(() => listReviewOutcomes(revision.id)) : [];
          return serialize(change, revision, outcomes);
        }),
      createReviewRun: (user, id) =>
        Effect.gen(function* () {
          const change = yield* owned(user, id);
          yield* requireOrganizationWrite(user, change.organization_id);
          if (change.status !== 'open') {
            return yield* Effect.fail(conflict(`Change is ${change.status}`));
          }
          const revision = yield* dataEffect(() => latestChangeRevision(id));
          if (!revision) return yield* Effect.fail(conflict('Change has no revision to review'));
          const key = `review:${change.id}:${revision.head_sha}:${crypto.randomUUID()}`;
          const started = yield* dataEffect(() =>
            createFactoryRunWithStage(
              {
                organizationId: change.organization_id,
                flowKey: REVIEW_FLOW.key,
                flowVersion: REVIEW_FLOW.version,
                changeId: change.id,
                trigger: 'manual',
                actorUserId: user.session.authUserId,
                idempotencyKey: key,
              },
              {
                stageKey: REVIEW_FLOW.initialStage,
                idempotencyKey: `${key}:${REVIEW_FLOW.initialStage}:1`,
              },
            ),
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
    } satisfies ChangeOperations;
  }),
);
