import { Context, Effect, Layer } from 'effect';
import {
  closeChangeRequest,
  createCockpitComment,
  createUserChatMessage,
  dispatchOpenCockpitComments,
  getChangeRequest,
  getFactoryRun,
  getFeature,
  getPlanByFeatureId,
  getRepoById,
  hasPendingChatTurn,
  latestExplanation,
  latestReadyExplanation,
  latestVerificationForFeature,
  listAgentRunsForFeature,
  listChatMessages,
  listCockpitComments,
  listCrChecks,
  listCrComments,
  listFactoryRunsForFeature,
  listLifecycleEvents,
  listStageRuns,
  setFeatureCriteriaConflict,
  tryRecordExplanation,
  updateFeature,
  updateFeatureAcceptance,
  type ExplanationRow,
  type FeatureRow,
  type RepositoryRow,
} from '../../../data/db.ts';
import { explainInstanceId, parseExplanationDocument } from '../../../domain/explain.ts';
import { type LifecycleDecision } from '../../../domain/lifecycle-contract.ts';
import { DEFAULT_MODEL } from '../../../domain/personas.ts';
import { formatUnmetCriteriaFindings, gradedCriteria } from '../../../domain/verification.ts';
import { installationToken } from '../../../integrations/github/app.ts';
import { githubJsonCached, githubRequest } from '../../../integrations/github/client.ts';
import { signArtifactKey } from '../../../integrations/security/crypto.ts';
import { capabilityDenied } from '../../../application/auth/access-control.ts';
import { loadImmutableJson } from '../../../application/cache/immutable-json.ts';
import { mergePullRequest } from '../../../application/deliveries/auto-merge.ts';
import { certificateUrl } from '../../../application/deliveries/certificates.ts';
import {
  CR_BOT_AUTHOR,
  changeRequestFiles,
} from '../../../application/deliveries/change-requests.ts';
import { loadFeatureDiff } from '../../../application/deliveries/feature-diff.ts';
import { githubTokenForUser } from '../../../application/auth/session.ts';
import {
  checkMergeability,
  dispatchConflictResolution,
} from '../../../application/deliveries/merge-conflicts.ts';
import { resumeFailedStage } from '../../../application/factory/lifecycle.ts';
import { parseUtc, VERIFY_STALL_AFTER_MS } from '../../../shared/time.ts';
import { isJsonObject, isString, type JsonValue } from '../../../shared/json.ts';
import type { CurrentUserIdentity } from '../../contract/auth.ts';
import type {
  CreateComment,
  CreateMessage,
  Delivery,
  DeliveryDiff,
  DeliveryExplanation,
  GenerateExplanation,
  ReplaceAcceptanceContract,
} from '../../contract/deliveries.ts';
import {
  badRequest,
  conflict,
  forbidden,
  internalServerError,
  notFound,
  upstreamFailure,
  type DomainError,
} from '../../contract/errors.ts';
import { ApiDependencies } from '../context.ts';

type AuthorizedDelivery = { feature: FeatureRow; repository: RepositoryRow };
type ActionAccepted = { status: 'queued' };

export interface DeliveryOperations {
  readonly get: (user: CurrentUserIdentity, id: number) => Effect.Effect<Delivery, DomainError>;
  readonly diff: (
    user: CurrentUserIdentity,
    id: number,
    version?: string,
  ) => Effect.Effect<DeliveryDiff, DomainError>;
  readonly explanation: (
    user: CurrentUserIdentity,
    id: number,
    version?: string,
  ) => Effect.Effect<DeliveryExplanation, DomainError>;
  readonly generateExplanation: (
    user: CurrentUserIdentity,
    id: number,
    input: GenerateExplanation,
  ) => Effect.Effect<DeliveryExplanation, DomainError>;
  readonly createComment: (
    user: CurrentUserIdentity,
    id: number,
    input: CreateComment,
  ) => Effect.Effect<{ commentId: number }, DomainError>;
  readonly createFixRun: (
    user: CurrentUserIdentity,
    id: number,
  ) => Effect.Effect<{ submittedCommentCount: number; status: 'queued' }, DomainError>;
  readonly listMessages: (
    user: CurrentUserIdentity,
    id: number,
  ) => Effect.Effect<
    {
      items: {
        id: number;
        role: 'user' | 'assistant';
        body: string;
        author: string | null;
        status: string;
        outcome: string | null;
        commitSha: string | null;
        error: string | null;
        createdAt: string;
      }[];
    },
    DomainError
  >;
  readonly createMessage: (
    user: CurrentUserIdentity,
    id: number,
    input: CreateMessage,
  ) => Effect.Effect<{ messageId: number; status: 'queued' }, DomainError>;
  readonly retry: (
    user: CurrentUserIdentity,
    id: number,
  ) => Effect.Effect<ActionAccepted, DomainError>;
  readonly resumeReviewRun: (
    user: CurrentUserIdentity,
    runId: number,
  ) => Effect.Effect<
    { status: 'queued'; stage: string; attempt: number; stageRunId: number },
    DomainError
  >;
  readonly replaceAcceptanceContract: (
    user: CurrentUserIdentity,
    id: number,
    input: ReplaceAcceptanceContract,
  ) => Effect.Effect<ActionAccepted, DomainError>;
  readonly resolveAcceptanceConflict: (
    user: CurrentUserIdentity,
    id: number,
  ) => Effect.Effect<ActionAccepted, DomainError>;
  readonly merge: (
    user: CurrentUserIdentity,
    id: number,
  ) => Effect.Effect<
    { status: 'queued' | 'completed'; conflictResolutionQueued: boolean },
    DomainError
  >;
  readonly close: (
    user: CurrentUserIdentity,
    id: number,
  ) => Effect.Effect<{ status: 'queued' | 'completed'; branchDeleted: boolean }, DomainError>;
}

export class DeliveryService extends Context.Tag('Turbodiff/DeliveryService')<
  DeliveryService,
  DeliveryOperations
>() {}

const operation = <A>(run: () => Promise<A>): Effect.Effect<A, DomainError> =>
  Effect.tryPromise({
    try: run,
    catch: (failure) => {
      console.error('turbodiff: Effect delivery operation failed', failure);
      return internalServerError();
    },
  });

const version = (raw: string | undefined): string | null =>
  raw && /^[0-9a-f]{7,64}$/i.test(raw) ? raw.toLowerCase() : null;

function serializeExplanation(head: string | null, row: ExplanationRow | null) {
  const document = row?.status === 'ready' ? parseExplanationDocument(row.document) : null;
  return {
    version: head,
    status: !row ? 'none' : row.status === 'ready' && !document ? 'failed' : row.status,
    document,
    model: row?.model ?? null,
    error:
      row?.status === 'ready' && !document ? 'stored document is unreadable' : (row?.error ?? null),
    createdAt: row?.created_at ?? null,
    completedAt: row?.completed_at ?? null,
    previous: null,
  } satisfies DeliveryExplanation;
}

function lifecycleReason(decision: LifecycleDecision | null): string | null {
  return decision && 'reason' in decision ? decision.reason : null;
}

function stageVerdict(output: JsonValue | null): string | null {
  if (!isJsonObject(output) || output.kind !== 'verification_completed') return null;
  return isString(output.status) ? output.status : null;
}

export const DeliveryServiceLive = Layer.effect(
  DeliveryService,
  Effect.gen(function* () {
    const dependencies = yield* ApiDependencies;

    const authorized = (user: CurrentUserIdentity, id: number) =>
      operation(async (): Promise<AuthorizedDelivery | null> => {
        const feature = await getFeature(id);
        const repository = feature ? await getRepoById(feature.repository_id) : null;
        return feature && repository && user.installationIds.includes(repository.installation_id)
          ? { feature, repository }
          : null;
      }).pipe(
        Effect.flatMap((delivery) =>
          delivery ? Effect.succeed(delivery) : Effect.fail(notFound('Unknown delivery')),
        ),
      );

    const requireSettings = (user: CurrentUserIdentity, installationId: number) =>
      operation(() =>
        capabilityDenied(user, installationId, 'settings', dependencies.orgAdmin),
      ).pipe(Effect.flatMap((denial) => (denial ? Effect.fail(forbidden(denial)) : Effect.void)));

    const requireWrite = (user: CurrentUserIdentity, repository: RepositoryRow) =>
      repository.provider === 'artifacts'
        ? requireSettings(user, repository.installation_id)
        : operation(() => dependencies.canPushToRepo(user, repository.owner, repository.name)).pipe(
            Effect.flatMap((allowed) =>
              allowed
                ? Effect.void
                : Effect.fail(forbidden('Push permission is required for this action')),
            ),
          );

    const explanation = (feature: FeatureRow, head: string | null) =>
      Effect.gen(function* () {
        const current = head ? yield* operation(() => latestExplanation(feature.id, head)) : null;
        const currentResponse = serializeExplanation(head, current);
        if (currentResponse.status !== 'ready') {
          const prior = yield* operation(() => latestReadyExplanation(feature.id));
          const document = prior ? parseExplanationDocument(prior.document) : null;
          if (prior && document && prior.head_sha !== head) {
            return {
              ...currentResponse,
              previous: {
                version: prior.head_sha,
                document,
                completedAt: prior.completed_at ?? prior.created_at,
              },
            } satisfies DeliveryExplanation;
          }
        }
        return currentResponse;
      });

    return {
      get: (user, id) =>
        Effect.gen(function* () {
          const { feature, repository } = yield* authorized(user, id);
          const [agentRuns, reviewRuns] = yield* operation(() =>
            Promise.all([
              listAgentRunsForFeature(feature.id),
              listFactoryRunsForFeature(feature.id),
            ]),
          );
          const base = {
            delivery: {
              id: feature.id,
              changeId: feature.change_id,
              title: feature.title,
              status: feature.status,
              error: feature.error,
              pullRequestNumber: feature.pr_number,
              criteriaConflict: feature.criteria_conflict,
              proposedCriteria: feature.proposed_acceptance,
            },
            repository: {
              id: repository.id,
              slug: `${repository.owner}/${repository.name}`,
              provider: repository.provider,
            },
            diffVersion: null,
            nativeChangeNumber: null,
            checks: [],
            plan: null,
            change: null,
            reviews: [],
            comments: [],
            demo: null,
            certificateUrl: null,
            criteria: [],
            verification: null,
            agentRuns: agentRuns.map((run) => ({
              id: run.id,
              kind: run.kind,
              success: run.success,
              createdAt: run.created_at,
            })),
            reviewRuns: yield* Effect.forEach(reviewRuns, (run) =>
              operation(async () => {
                const [stages, events] = await Promise.all([
                  listStageRuns(run.id),
                  listLifecycleEvents(run.id),
                ]);
                return {
                  id: run.id,
                  profile: run.profile_key,
                  status: run.status,
                  startStage: run.start_stage,
                  stopAfterStage: run.stop_after_stage,
                  handoffReason: run.handoff_reason,
                  createdAt: run.created_at,
                  completedAt: run.completed_at,
                  stages: stages.map((stage) => ({
                    id: stage.id,
                    stage: stage.stage,
                    attempt: stage.attempt,
                    status: stage.status,
                    verdict: stageVerdict(stage.output),
                    error: stage.error,
                    startedAt: stage.started_at,
                    completedAt: stage.completed_at,
                  })),
                  events: events.map((event) => ({
                    key: event.idempotency_key,
                    kind: event.kind,
                    decision: event.decision?.kind ?? null,
                    reason: lifecycleReason(event.decision),
                    createdAt: event.created_at,
                  })),
                };
              }),
            ),
          } satisfies Delivery;
          if (!feature.pr_number) return base;

          const [plan, verification, comments] = yield* operation(() =>
            Promise.all([
              getPlanByFeatureId(feature.id),
              latestVerificationForFeature(feature.id),
              listCockpitComments(feature.id),
            ]),
          );
          const serializedComments = comments.map((comment) => ({
            id: comment.id,
            path: comment.path,
            line: comment.line,
            side: comment.side,
            body: comment.body,
            author: comment.author,
            status: comment.status,
            createdAt: comment.created_at,
            fixStatus: comment.fix_status,
          }));
          const signedCertificateUrl = yield* operation(() => certificateUrl(feature.id));

          const providerDetails =
            repository.provider === 'artifacts'
              ? yield* Effect.gen(function* () {
                  const changeRequest = feature.change_request_id
                    ? yield* operation(() => getChangeRequest(feature.change_request_id!))
                    : null;
                  if (!changeRequest) {
                    return {
                      diffVersion: null,
                      nativeChangeNumber: null,
                      change: null,
                      reviews: [],
                      checks: [],
                    } satisfies Pick<
                      Delivery,
                      'diffVersion' | 'nativeChangeNumber' | 'change' | 'reviews' | 'checks'
                    >;
                  }
                  const files = changeRequestFiles(changeRequest);
                  const [nativeComments, checks] = yield* operation(() =>
                    Promise.all([listCrComments(changeRequest.id), listCrChecks(changeRequest.id)]),
                  );
                  const findings = nativeComments.filter((comment) => comment.kind === 'finding');
                  const summary = nativeComments
                    .filter((comment) => comment.kind === 'summary')
                    .at(-1);
                  const reviews = changeRequest.review_status
                    ? [
                        {
                          state:
                            changeRequest.review_status === 'approved'
                              ? 'APPROVED'
                              : 'CHANGES_REQUESTED',
                          body:
                            (summary?.body ?? '') +
                            (findings.length > 0
                              ? `\n\n${findings
                                  .map(
                                    (finding) =>
                                      `- **${finding.severity ?? 'P3'}** ${finding.file ?? ''}${finding.line ? `:${finding.line}` : ''} — ${finding.body}`,
                                  )
                                  .join('\n')}`
                              : ''),
                          author: CR_BOT_AUTHOR,
                        },
                      ]
                    : [];
                  return {
                    diffVersion: changeRequest.source_head,
                    nativeChangeNumber: changeRequest.number,
                    change: {
                      state: changeRequest.status,
                      url: null,
                      additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
                      deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
                      changedFiles: files.length,
                      mergeability:
                        changeRequest.mergeable === false
                          ? 'dirty'
                          : changeRequest.mergeable === true
                            ? 'clean'
                            : null,
                    },
                    reviews,
                    checks: checks.map((check) => {
                      const stalled =
                        check.name === 'review' &&
                        check.status === 'running' &&
                        Date.now() - parseUtc(check.updated_at) > 15 * 60_000;
                      return {
                        name: check.name,
                        status: stalled ? 'error' : check.status,
                        summary: stalled
                          ? 'review stalled — start a new review run'
                          : check.summary,
                      };
                    }),
                  } satisfies Pick<
                    Delivery,
                    'diffVersion' | 'nativeChangeNumber' | 'change' | 'reviews' | 'checks'
                  >;
                })
              : yield* Effect.gen(function* () {
                  const token = yield* operation(() =>
                    installationToken(repository.installation_id),
                  );
                  const base = `/repos/${repository.owner}/${repository.name}`;
                  const [metadata, reviews] = yield* operation(() =>
                    Promise.all([
                      githubJsonCached<{
                        state: string;
                        merged: boolean;
                        html_url: string;
                        additions: number;
                        deletions: number;
                        changed_files: number;
                        mergeable_state: string | null;
                        head: { sha: string };
                      }>(token, `${base}/pulls/${feature.pr_number}`),
                      githubJsonCached<
                        { state: string; body: string; user: { login: string } | null }[]
                      >(token, `${base}/pulls/${feature.pr_number}/reviews?per_page=100`),
                    ]),
                  );
                  return {
                    diffVersion: metadata.head.sha,
                    nativeChangeNumber: null,
                    change: {
                      state: metadata.merged ? 'merged' : metadata.state,
                      url: metadata.html_url,
                      additions: metadata.additions,
                      deletions: metadata.deletions,
                      changedFiles: metadata.changed_files,
                      mergeability: metadata.mergeable_state,
                    },
                    reviews: reviews.map((review) => ({
                      state: review.state,
                      body: review.body,
                      author: review.user?.login ?? null,
                    })),
                    checks: [],
                  } satisfies Pick<
                    Delivery,
                    'diffVersion' | 'nativeChangeNumber' | 'change' | 'reviews' | 'checks'
                  >;
                });

          const demo = verification?.demo ?? null;
          const video = demo?.video;
          const serializedDemo = video
            ? {
                url: `/artifacts/${video}?sig=${yield* operation(() => signArtifactKey(video))}`,
                caption: demo.caption ?? null,
              }
            : null;
          const criteria = yield* Effect.forEach(
            gradedCriteria(feature.acceptance ?? [], verification?.results ?? []),
            ({ text, result }) =>
              Effect.gen(function* () {
                const key = result?.screenshot
                  ? `verify/${feature.id}/${result.screenshot.replace(/[^\w.-]/g, '')}`
                  : null;
                return {
                  text,
                  verdict: result?.verdict ?? null,
                  note: result?.note ?? null,
                  screenshotUrl: key
                    ? `/artifacts/${key}?sig=${yield* operation(() => signArtifactKey(key))}`
                    : null,
                };
              }),
          );
          const results = verification?.results ?? [];
          const verificationSummary = verification
            ? {
                status:
                  verification.status === 'running' &&
                  Date.now() - parseUtc(verification.created_at) > VERIFY_STALL_AFTER_MS
                    ? 'stalled'
                    : verification.status,
                total: results.length,
                failed: results.filter((result) => result.verdict === 'fail').length,
              }
            : null;
          return {
            ...base,
            ...providerDetails,
            plan: plan?.plan ?? null,
            comments: serializedComments,
            certificateUrl: signedCertificateUrl,
            demo: serializedDemo,
            criteria,
            verification: verificationSummary,
          } satisfies Delivery;
        }),
      diff: (user, id, rawVersion) =>
        Effect.gen(function* () {
          const { feature, repository } = yield* authorized(user, id);
          const requested = version(rawVersion);
          if (rawVersion && !requested)
            return yield* Effect.fail(badRequest('Invalid diff version'));
          const nativeChange =
            repository.provider === 'artifacts' && feature.change_request_id
              ? yield* operation(() => getChangeRequest(feature.change_request_id!))
              : null;
          const diffVersion = nativeChange?.source_head ?? requested;
          const cacheKey = diffVersion
            ? `delivery-diff/${feature.id}/${encodeURIComponent(diffVersion)}`
            : null;
          const result = yield* operation(() =>
            loadImmutableJson(dependencies.defer, cacheKey, () =>
              loadFeatureDiff(feature, repository, nativeChange, requested),
            ),
          );
          return {
            version: result.version,
            files: result.files,
            remainingFileCount: result.more_files,
          };
        }),
      explanation: (user, id, rawVersion) =>
        Effect.gen(function* () {
          const { feature } = yield* authorized(user, id);
          const head = version(rawVersion);
          if (rawVersion && !head) return yield* Effect.fail(badRequest('Invalid diff version'));
          return yield* explanation(feature, head);
        }),
      generateExplanation: (user, id, input) =>
        Effect.gen(function* () {
          const { feature, repository } = yield* authorized(user, id);
          if (!feature.pr_number) return yield* Effect.fail(conflict('No change to explain yet'));
          const head = version(input.version);
          if (!head)
            return yield* Effect.fail(badRequest('A commit-like diff version is required'));
          if (!input.force) {
            const existing = yield* operation(() => latestExplanation(feature.id, head));
            if (existing && existing.status !== 'failed')
              return serializeExplanation(head, existing);
          }
          const instanceId = explainInstanceId(feature.id, head, crypto.randomUUID().slice(0, 8));
          const rowId = yield* operation(() =>
            tryRecordExplanation(feature.id, head, instanceId, DEFAULT_MODEL),
          );
          if (rowId === null)
            return yield* Effect.fail(conflict('An explanation is already being written'));
          yield* operation(() =>
            dependencies.dispatchExplain(feature, repository, head, instanceId, DEFAULT_MODEL),
          );
          return yield* explanation(feature, head);
        }),
      createComment: (user, id, input) =>
        Effect.gen(function* () {
          const { feature } = yield* authorized(user, id);
          const path = input.path.trim();
          const body = input.body.trim();
          if (!feature.pr_number) return yield* Effect.fail(conflict('No change exists yet'));
          if (!path || !body) return yield* Effect.fail(badRequest('path and body are required'));
          const commentId = yield* operation(() =>
            createCockpitComment(
              feature.id,
              path,
              input.line,
              input.side ?? 'additions',
              body,
              user.session.login,
              user.session.userId,
            ),
          );
          return { commentId };
        }),
      createFixRun: (user, id) =>
        Effect.gen(function* () {
          const { feature, repository } = yield* authorized(user, id);
          if (!feature.pr_number) return yield* Effect.fail(conflict('No change exists yet'));
          if (!repository.auto_fix)
            return yield* Effect.fail(conflict('Enable auto-fix before submitting comments'));
          yield* requireWrite(user, repository);
          const claimed = yield* operation(() => dispatchOpenCockpitComments(feature.id));
          if (claimed.length === 0)
            return yield* Effect.fail(badRequest('No pending comments to submit'));
          const findings = claimed
            .map(
              (comment) =>
                `**P1** — Reviewer comment on \`${comment.path}:${comment.line}\` ` +
                `(from @${comment.author}):\n\n${comment.body}`,
            )
            .join('\n\n---\n\n');
          yield* operation(() =>
            dependencies.enqueueFactory({
              kind: 'fix',
              repoId: repository.id,
              prNumber: feature.pr_number!,
              trigger: 'cockpit_comment',
              author: { login: user.session.login, id: user.session.userId },
              findings,
              commentIds: claimed.map((comment) => comment.id),
            }),
          );
          return { submittedCommentCount: claimed.length, status: 'queued' as const };
        }),
      listMessages: (user, id) =>
        Effect.gen(function* () {
          const { feature } = yield* authorized(user, id);
          const messages = yield* operation(() => listChatMessages(feature.id));
          return {
            items: messages.map((message) => ({
              id: message.id,
              // SAFETY: writers restrict role to this closed pair.
              role: message.role as 'user' | 'assistant',
              body: message.body,
              author: message.author,
              status: message.status,
              outcome: message.outcome,
              commitSha: message.commit_sha,
              error: message.error,
              createdAt: message.created_at,
            })),
          };
        }),
      createMessage: (user, id, input) =>
        Effect.gen(function* () {
          const { feature, repository } = yield* authorized(user, id);
          const body = input.body.trim();
          if (!body) return yield* Effect.fail(badRequest('body is required'));
          if (!feature.pr_number || feature.status !== 'pr_opened')
            return yield* Effect.fail(conflict('This delivery has no open change'));
          yield* requireWrite(user, repository);
          if (yield* operation(() => hasPendingChatTurn(feature.id)))
            return yield* Effect.fail(conflict('A chat turn is already running'));
          const messageId = yield* operation(() =>
            createUserChatMessage(feature.id, body, user.session.login, user.session.userId),
          );
          yield* operation(() =>
            dependencies.enqueueFactory({
              kind: 'chat',
              featureId: feature.id,
              chatMessageId: messageId,
            }),
          );
          return { messageId, status: 'queued' as const };
        }),
      retry: (user, id) =>
        Effect.gen(function* () {
          const { feature } = yield* authorized(user, id);
          if (!['failed', 'checks_failed', 'no_changes'].includes(feature.status))
            return yield* Effect.fail(conflict(`Delivery is ${feature.status}, not retryable`));
          yield* operation(() => updateFeature(feature.id, { error: 'retry queued' }));
          yield* operation(() =>
            dependencies.enqueueFactory({ kind: 'generate', featureId: feature.id }),
          );
          return { status: 'queued' as const };
        }),
      resumeReviewRun: (user, runId) =>
        Effect.gen(function* () {
          const run = yield* operation(() => getFactoryRun(runId));
          const repository = run ? yield* operation(() => getRepoById(run.repository_id)) : null;
          if (!run || !repository || !user.installationIds.includes(repository.installation_id))
            return yield* Effect.fail(notFound('Unknown review run'));
          const result = yield* operation(() =>
            resumeFailedStage(run.id, user.session.login, dependencies.enqueueFactory),
          );
          if (result.kind === 'rejected') return yield* Effect.fail(conflict(result.reason));
          return {
            status: 'queued' as const,
            stage: result.stage,
            attempt: result.attempt,
            stageRunId: result.stageRunId,
          };
        }),
      replaceAcceptanceContract: (user, id, input) =>
        Effect.gen(function* () {
          const { feature, repository } = yield* authorized(user, id);
          yield* requireSettings(user, repository.installation_id);
          const criteria = input.criteria.map((item) => item.trim()).filter(Boolean);
          if (criteria.length === 0)
            return yield* Effect.fail(badRequest('At least one criterion is required'));
          if (
            feature.acceptance &&
            JSON.stringify(criteria) === JSON.stringify(feature.acceptance)
          ) {
            return yield* Effect.fail(conflict('The acceptance contract is unchanged'));
          }
          yield* operation(() => updateFeatureAcceptance(feature.id, criteria));
          yield* operation(() =>
            dependencies.enqueueFactory({ kind: 'verify', featureId: feature.id }),
          );
          return { status: 'queued' as const };
        }),
      resolveAcceptanceConflict: (user, id) =>
        Effect.gen(function* () {
          const { feature, repository } = yield* authorized(user, id);
          yield* requireSettings(user, repository.installation_id);
          if (!feature.criteria_conflict || !feature.pr_number)
            return yield* Effect.fail(conflict('No acceptance conflict exists'));
          const verification = yield* operation(() => latestVerificationForFeature(feature.id));
          yield* operation(() => setFeatureCriteriaConflict(feature.id, false));
          yield* operation(() =>
            dependencies.enqueueFactory({
              kind: 'fix',
              repoId: repository.id,
              prNumber: feature.pr_number!,
              trigger: 'verification_failed',
              findings: formatUnmetCriteriaFindings(
                feature.acceptance ?? [],
                verification?.results ?? [],
              ),
            }),
          );
          return { status: 'queued' as const };
        }),
      merge: (user, id) =>
        Effect.gen(function* () {
          const { feature, repository } = yield* authorized(user, id);
          if (!feature.pr_number) return yield* Effect.fail(conflict('No change exists yet'));
          yield* requireWrite(user, repository);
          if (repository.provider === 'artifacts') {
            if (!feature.change_request_id)
              return yield* Effect.fail(conflict('No native change request exists'));
            const changeRequest = yield* operation(() =>
              getChangeRequest(feature.change_request_id!),
            );
            if (!changeRequest)
              return yield* Effect.fail(conflict('Unknown native change request'));
            if (changeRequest.status === 'merged')
              return { status: 'completed' as const, conflictResolutionQueued: false };
            if (changeRequest.status !== 'open')
              return yield* Effect.fail(conflict(`Change request is ${changeRequest.status}`));
            if (changeRequest.mergeable === false)
              return yield* Effect.fail(conflict('Merge blocked by conflicts'));
            yield* operation(() =>
              dependencies.enqueueFactory({
                kind: 'cr_merge',
                changeRequestId: changeRequest.id,
                actor: user.session.login || 'cockpit',
              }),
            );
            return { status: 'queued' as const, conflictResolutionQueued: false };
          }
          const appToken = yield* operation(() => installationToken(repository.installation_id));
          const mergeability = yield* operation(() =>
            checkMergeability(appToken, repository.owner, repository.name, feature.pr_number!, {
              retryOnUnknown: true,
            }),
          );
          if (mergeability.hasConflict) {
            const queued = yield* operation(() =>
              dispatchConflictResolution(repository, feature.pr_number!),
            );
            if (!queued) return yield* Effect.fail(conflict('Merge blocked by conflicts'));
            return { status: 'queued' as const, conflictResolutionQueued: true };
          }
          const userToken = yield* operation(() => githubTokenForUser(user));
          const merge = () =>
            mergePullRequest(
              userToken || appToken,
              repository.owner,
              repository.name,
              feature.pr_number!,
            ).catch(() =>
              userToken
                ? mergePullRequest(appToken, repository.owner, repository.name, feature.pr_number!)
                : Promise.reject(new Error('GitHub merge failed')),
            );
          yield* Effect.tryPromise({
            try: merge,
            catch: () => upstreamFailure('GitHub merge failed'),
          });
          yield* operation(() => updateFeature(feature.id, { status: 'merged' }));
          return { status: 'completed' as const, conflictResolutionQueued: false };
        }),
      close: (user, id) =>
        Effect.gen(function* () {
          const { feature, repository } = yield* authorized(user, id);
          if (!feature.pr_number) return yield* Effect.fail(conflict('No change exists yet'));
          yield* requireWrite(user, repository);
          if (repository.provider === 'artifacts') {
            if (!feature.change_request_id)
              return yield* Effect.fail(conflict('No native change request exists'));
            yield* operation(() => closeChangeRequest(feature.change_request_id!));
            yield* operation(() => updateFeature(feature.id, { status: 'abandoned' }));
            return { status: 'completed' as const, branchDeleted: false };
          }
          const appToken = yield* operation(() => installationToken(repository.installation_id));
          const userToken = yield* operation(() => githubTokenForUser(user));
          const token = userToken || appToken;
          const path = `/repos/${repository.owner}/${repository.name}/pulls/${feature.pr_number}`;
          const close = () =>
            githubRequest(token, path, {
              method: 'PATCH',
              body: JSON.stringify({ state: 'closed' }),
            }).catch(() =>
              userToken
                ? githubRequest(appToken, path, {
                    method: 'PATCH',
                    body: JSON.stringify({ state: 'closed' }),
                  })
                : Promise.reject(new Error('GitHub close failed')),
            );
          yield* Effect.tryPromise({
            try: close,
            catch: () => upstreamFailure('GitHub close failed'),
          });
          let branchDeleted = false;
          if (feature.branch) {
            const branchPath = `/repos/${repository.owner}/${repository.name}/git/refs/heads/${encodeURIComponent(feature.branch)}`;
            branchDeleted = yield* Effect.tryPromise({
              try: () => githubRequest(token, branchPath, { method: 'DELETE' }).then(() => true),
              catch: () => false,
            }).pipe(Effect.catchAll(() => Effect.succeed(false)));
          }
          yield* operation(() => updateFeature(feature.id, { status: 'abandoned' }));
          return { status: 'completed' as const, branchDeleted };
        }),
    } satisfies DeliveryOperations;
  }),
);
