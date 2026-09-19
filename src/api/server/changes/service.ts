import { listChangeChecks } from '../../../data/change-checks.ts';
import { reviewArtifactSchema } from '../../../artifacts/review.ts';
import { Context, Effect, Layer } from 'effect';
import {
  getChange,
  latestChangeRevision,
  listChangesForRepository,
  listReviewOutcomes,
  updateChangeStatus,
  type ChangeRevisionRow,
  type ChangeRow,
} from '../../../data/changes.ts';
import {
  createFactoryRunWithStage,
  listAgentRunsForFactoryRun,
  listFactoryRuns,
  listStageRuns,
} from '../../../data/execution.ts';
import { getRepository } from '../../../data/repositories.ts';
import { closeGithubChange, mergeGithubChange } from '../../../integrations/changes/github.ts';
import { EXPLANATION_FLOW, REVIEW_FLOW } from '../../../application/factory/flows.ts';
import { getArtifact } from '../../../data/artifacts.ts';
import { explanationArtifactSchema } from '../../../artifacts/explanation.ts';
import { loadJsonArtifact } from '../../../application/artifacts.ts';
import type { CurrentUserIdentity } from '../../contract/auth.ts';
import type {
  Change,
  ChangeCollection,
  ChangeExplanation,
  ChangeTransition,
} from '../../contract/changes.ts';
import {
  conflict,
  internalServerError,
  notFound,
  upstreamFailure,
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

const providerEffect = <A>(run: () => Promise<A>): Effect.Effect<A, DomainError> =>
  Effect.tryPromise({
    try: run,
    catch: (failure) => {
      console.error('turbodiff: change provider operation failed', failure);
      return upstreamFailure('Change provider operation failed');
    },
  });

type ReviewOutcome = Awaited<ReturnType<typeof listReviewOutcomes>>[number];
const reviewDetails = async (outcome: ReviewOutcome) => {
  const row = await getArtifact(outcome.output_artifact_id);
  if (!row || row.organization_id !== outcome.organization_id)
    throw new Error('review artifact is missing');
  const artifact = await loadJsonArtifact(row, reviewArtifactSchema);
  return { ...outcome, summary: artifact.summary, findings: artifact.findings };
};
const serializeRevision = (
  revision: ChangeRevisionRow | null,
  outcomes: Array<Awaited<ReturnType<typeof reviewDetails>>>,
) =>
  revision
    ? {
        id: revision.id,
        version: revision.version,
        baseSha: revision.base_sha,
        headSha: revision.head_sha,
        artifactId: revision.artifact_id,
        reviewOutcomes: outcomes.map((outcome) => ({
          agentRunId: outcome.agent_run_id,
          author: outcome.agent_name,
          summary: outcome.summary,
          findings: outcome.findings,
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

const serialize = async (
  change: ChangeRow,
  revision: ChangeRevisionRow | null,
  outcomes: ReviewOutcome[],
): Promise<Change> => ({
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
  currentRevision: serializeRevision(revision, await Promise.all(outcomes.map(reviewDetails))),
  checks: revision
    ? (await listChangeChecks(revision.id)).map((check) => ({
        name: check.name,
        status: check.status,
        conclusion: check.conclusion,
        detailsUrl: check.details_url,
      }))
    : [],
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
  readonly merge: (
    user: CurrentUserIdentity,
    id: number,
  ) => Effect.Effect<ChangeTransition, DomainError>;
  readonly close: (
    user: CurrentUserIdentity,
    id: number,
  ) => Effect.Effect<ChangeTransition, DomainError>;
  readonly getExplanation: (
    user: CurrentUserIdentity,
    id: number,
  ) => Effect.Effect<ChangeExplanation, DomainError>;
  readonly createExplanationRun: (
    user: CurrentUserIdentity,
    id: number,
    force: boolean,
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
            items: yield* dataEffect(() =>
              Promise.all(
                rows.map((change, index) =>
                  serialize(change, revisions[index] ?? null, outcomes[index] ?? []),
                ),
              ),
            ),
          };
        }),
      get: (user, id) =>
        Effect.gen(function* () {
          const change = yield* owned(user, id);
          const revision = yield* dataEffect(() => latestChangeRevision(id));
          const outcomes = revision ? yield* dataEffect(() => listReviewOutcomes(revision.id)) : [];
          return yield* dataEffect(() => serialize(change, revision, outcomes));
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
      merge: (user, id) =>
        Effect.gen(function* () {
          const change = yield* owned(user, id);
          yield* requireOrganizationWrite(user, change.organization_id);
          if (change.status === 'merged') return { status: 'merged' as const };
          if (change.status !== 'open') {
            return yield* Effect.fail(conflict(`Change is ${change.status}`));
          }
          const repository = yield* dataEffect(() => getRepository(change.repository_id));
          if (!repository) return yield* Effect.fail(notFound('Unknown repository'));
          if (repository.source_provider !== 'github') {
            return yield* Effect.fail(conflict('This change provider does not support merging'));
          }
          yield* providerEffect(() => mergeGithubChange(repository, change));
          yield* dataEffect(() => updateChangeStatus(change.id, 'merged'));
          return { status: 'merged' as const };
        }),
      close: (user, id) =>
        Effect.gen(function* () {
          const change = yield* owned(user, id);
          yield* requireOrganizationWrite(user, change.organization_id);
          if (change.status === 'closed') {
            return { status: 'closed' as const, branchDeleted: false };
          }
          if (change.status !== 'open') {
            return yield* Effect.fail(conflict(`Change is ${change.status}`));
          }
          const repository = yield* dataEffect(() => getRepository(change.repository_id));
          if (!repository) return yield* Effect.fail(notFound('Unknown repository'));
          if (repository.source_provider !== 'github') {
            return yield* Effect.fail(conflict('This change provider does not support closing'));
          }
          const result = yield* providerEffect(() => closeGithubChange(repository, change));
          yield* dataEffect(() => updateChangeStatus(change.id, 'closed'));
          return { status: 'closed' as const, branchDeleted: result.branchDeleted };
        }),
      getExplanation: (user, id) =>
        Effect.gen(function* () {
          yield* owned(user, id);
          const revision = yield* dataEffect(() => latestChangeRevision(id));
          if (!revision) {
            return {
              revisionId: null,
              headSha: null,
              status: 'none' as const,
              artifactId: null,
              document: null,
              error: null,
              createdAt: null,
              completedAt: null,
            };
          }
          const runs = (yield* dataEffect(() => listFactoryRuns({ changeId: id }))).filter(
            (run) => run.flow_key === EXPLANATION_FLOW.key,
          );
          for (const run of runs) {
            const agentRuns = yield* dataEffect(() => listAgentRunsForFactoryRun(run.id));
            const completed = agentRuns.find(
              (agentRun) => agentRun.status === 'succeeded' && agentRun.output_artifact_id,
            );
            const outputArtifactId = completed?.output_artifact_id;
            if (outputArtifactId) {
              const artifactRow = yield* dataEffect(() => getArtifact(outputArtifactId));
              if (artifactRow) {
                const artifact = yield* dataEffect(() =>
                  loadJsonArtifact(artifactRow, explanationArtifactSchema),
                );
                if (artifact.revisionId === revision.id) {
                  return {
                    revisionId: revision.id,
                    headSha: revision.head_sha,
                    status: 'ready' as const,
                    artifactId: artifactRow.id,
                    document: artifact.document,
                    error: null,
                    createdAt: run.created_at,
                    completedAt: run.completed_at,
                  };
                }
              }
            }
            if (run.status === 'queued' || run.status === 'running') {
              return {
                revisionId: revision.id,
                headSha: revision.head_sha,
                status: run.status,
                artifactId: null,
                document: null,
                error: null,
                createdAt: run.created_at,
                completedAt: null,
              };
            }
            if (run.status === 'failed') {
              return {
                revisionId: revision.id,
                headSha: revision.head_sha,
                status: 'failed' as const,
                artifactId: null,
                document: null,
                error: 'Explanation run failed',
                createdAt: run.created_at,
                completedAt: run.completed_at,
              };
            }
          }
          return {
            revisionId: revision.id,
            headSha: revision.head_sha,
            status: 'none' as const,
            artifactId: null,
            document: null,
            error: null,
            createdAt: null,
            completedAt: null,
          };
        }),
      createExplanationRun: (user, id, force) =>
        Effect.gen(function* () {
          const change = yield* owned(user, id);
          yield* requireOrganizationWrite(user, change.organization_id);
          const revision = yield* dataEffect(() => latestChangeRevision(id));
          if (!revision) return yield* Effect.fail(conflict('Change has no revision to explain'));
          if (!force) {
            const runs = (yield* dataEffect(() => listFactoryRuns({ changeId: id }))).filter(
              (run) =>
                run.flow_key === EXPLANATION_FLOW.key &&
                (run.status === 'queued' || run.status === 'running'),
            );
            const existing = runs[0];
            if (existing) {
              const stages = yield* dataEffect(() => listStageRuns(existing.id));
              const stage = stages.at(-1);
              if (stage) {
                return {
                  factoryRunId: existing.id,
                  stageRunId: stage.id,
                  status: 'queued' as const,
                };
              }
            }
          }
          const key = `explanation:${change.id}:${revision.head_sha}:${crypto.randomUUID()}`;
          const started = yield* dataEffect(() =>
            createFactoryRunWithStage(
              {
                organizationId: change.organization_id,
                flowKey: EXPLANATION_FLOW.key,
                flowVersion: EXPLANATION_FLOW.version,
                changeId: change.id,
                trigger: 'manual',
                actorUserId: user.session.authUserId,
                idempotencyKey: key,
              },
              {
                stageKey: EXPLANATION_FLOW.initialStage,
                idempotencyKey: `${key}:${EXPLANATION_FLOW.initialStage}:1`,
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
