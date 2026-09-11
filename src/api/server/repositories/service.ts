import { Context, Effect, Layer } from 'effect';
import {
  getAgentById,
  getRepoByFullName,
  getRepoById,
  getSkillById,
  ensureBuiltinAgents,
  listAgents,
  listInstallationsWithRepos,
  listRepoAgentOverrides,
  listRepoSkillOverrides,
  listSkills,
  repositoryRef,
  resolveAgentEnabled,
  resolveSkillEnabled,
  setRepoAgentEnabled,
  setRepoAutoFix,
  setRepoAutoMerge,
  setRepoAutoResolveConflicts,
  setRepoBlockingReviews,
  setRepoCheckCommand,
  setRepoDemoVideos,
  setRepoEnabled,
  setRepoProcessProfile,
  setRepoReviewOnPush,
  setRepoReviewPushDebounceMinutes,
  setRepoSkillEnabled,
  type RepositoryRow,
} from '../../../data/db.ts';
import { ADOPTABLE_PROCESS_PROFILE_KEYS } from '../../../domain/process-profiles.ts';
import { installationToken, sandboxGitToken } from '../../../integrations/github/app.ts';
import { capabilityDenied } from '../../../application/auth/access-control.ts';
import { loadImmutableJson } from '../../../application/cache/immutable-json.ts';
import { syncInstallationRepos } from '../../../application/repositories/sync.ts';
import {
  createArtifactsProject,
  mintArtifactsCloneToken,
  PROJECT_SEGMENT,
} from '../../../application/repositories/artifacts.ts';
import {
  isValidRepoPath,
  isValidRepoRef,
  listBranchesAndDefault,
  readFile,
  readTree,
  RepoBrowserError,
  saveFile,
} from '../../../integrations/source-code/github.ts';
import {
  listBranchesAndDefaultArtifacts,
  readFileArtifacts,
  readTreeArtifacts,
  saveFileArtifacts,
} from '../../../integrations/source-code/artifacts.ts';
import type { CurrentUserIdentity } from '../../contract/auth.ts';
import type {
  CloneCredential,
  CreateProject,
  InstallationCollection,
  Project,
  RepositoryCode,
  RepositoryFile,
  RepositorySettings,
  RepositoryTree,
  SaveRepositoryFile,
  SavedRepositoryFile,
  UpdateRepositorySettings,
} from '../../contract/repositories.ts';
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

export interface RepositoryOperations {
  readonly listInstallations: (
    user: CurrentUserIdentity,
  ) => Effect.Effect<InstallationCollection, DomainError>;
  readonly createProject: (
    user: CurrentUserIdentity,
    input: CreateProject,
  ) => Effect.Effect<Project, DomainError>;
  readonly createCloneCredential: (
    user: CurrentUserIdentity,
    id: number,
    scope: 'read' | 'write',
  ) => Effect.Effect<CloneCredential, DomainError>;
  readonly code: (
    user: CurrentUserIdentity,
    id: number,
  ) => Effect.Effect<RepositoryCode, DomainError>;
  readonly tree: (
    user: CurrentUserIdentity,
    id: number,
    ref: string,
    path: string,
  ) => Effect.Effect<RepositoryTree, DomainError>;
  readonly file: (
    user: CurrentUserIdentity,
    id: number,
    ref: string,
    path: string,
  ) => Effect.Effect<RepositoryFile, DomainError>;
  readonly saveFile: (
    user: CurrentUserIdentity,
    id: number,
    input: SaveRepositoryFile,
  ) => Effect.Effect<SavedRepositoryFile, DomainError>;
  readonly updateSettings: (
    user: CurrentUserIdentity,
    id: number,
    input: UpdateRepositorySettings,
  ) => Effect.Effect<RepositorySettings, DomainError>;
  readonly setAgentEnabled: (
    user: CurrentUserIdentity,
    repositoryId: number,
    agentId: number,
    enabled: boolean,
  ) => Effect.Effect<void, DomainError>;
  readonly setSkillEnabled: (
    user: CurrentUserIdentity,
    repositoryId: number,
    skillId: number,
    enabled: boolean,
  ) => Effect.Effect<void, DomainError>;
}

export class RepositoryService extends Context.Tag('Turbodiff/RepositoryService')<
  RepositoryService,
  RepositoryOperations
>() {}

const dataOperation = <A>(run: () => Promise<A>): Effect.Effect<A, DomainError> =>
  Effect.tryPromise({
    try: run,
    catch: (error) => {
      console.error('turbodiff: Effect repository data operation failed', error);
      return internalServerError();
    },
  });

const providerOperation = <A>(run: () => Promise<A>): Effect.Effect<A, DomainError> =>
  Effect.tryPromise({
    try: run,
    catch: (error) => {
      if (error instanceof RepoBrowserError) {
        return error.status === 409 ? conflict(error.message) : badRequest(error.message);
      }
      const detail = error instanceof Error ? error.message : 'Repository provider request failed';
      console.error('turbodiff: Effect repository provider operation failed', error);
      return upstreamFailure(detail.slice(0, 500));
    },
  });

const serializeFile = (file: {
  path: string;
  ref: string;
  sha: string;
  size: number;
  text: string | null;
  binary: boolean;
  too_large: boolean;
  content_base64: string | null;
}): RepositoryFile => ({
  path: file.path,
  ref: file.ref,
  sha: file.sha,
  size: file.size,
  text: file.text,
  binary: file.binary,
  tooLarge: file.too_large,
  contentBase64: file.content_base64,
});

const serializeSettings = (repository: RepositoryRow): RepositorySettings => ({
  id: repository.id,
  enabled: repository.enabled,
  reviewOnPush: repository.review_on_push,
  reviewPushDebounceMinutes: repository.review_push_debounce_minutes,
  // `legacy_factory` is an internal compatibility profile with the same
  // stages as `full_delivery`; it is not part of the public API vocabulary.
  processProfile:
    repository.process_profile === 'legacy_factory' ? 'full_delivery' : repository.process_profile,
  blockingReviews: repository.blocking_reviews,
  autoFix: repository.auto_fix,
  autoMerge: repository.auto_merge,
  autoResolveConflicts: repository.auto_resolve_conflicts,
  demoVideos: repository.demo_videos,
  checkCommand: repository.check_command,
});

export const RepositoryServiceLive = Layer.effect(
  RepositoryService,
  Effect.gen(function* () {
    const dependencies = yield* ApiDependencies;

    const authorized = (user: CurrentUserIdentity, id: number) =>
      dataOperation(() => getRepoById(id)).pipe(
        Effect.flatMap((repository) =>
          repository && user.installationIds.includes(repository.installation_id)
            ? Effect.succeed(repository)
            : Effect.fail(notFound('Unknown repository')),
        ),
      );

    const requireSettings = (user: CurrentUserIdentity, installationId: number) =>
      dataOperation(() =>
        capabilityDenied(user, installationId, 'settings', dependencies.orgAdmin),
      ).pipe(Effect.flatMap((denial) => (denial ? Effect.fail(forbidden(denial)) : Effect.void)));

    const cached = <A>(key: string | null, load: () => Promise<A>) =>
      providerOperation(() => loadImmutableJson(dependencies.defer, key, load));

    const requireWrite = (user: CurrentUserIdentity, repository: RepositoryRow) =>
      repository.provider === 'artifacts'
        ? requireSettings(user, repository.installation_id)
        : dataOperation(() =>
            dependencies.canPushToRepo(user, repository.owner, repository.name),
          ).pipe(
            Effect.flatMap((allowed) =>
              allowed
                ? Effect.void
                : Effect.fail(
                    forbidden('Push access to the repository is required for this action'),
                  ),
            ),
          );

    const requireSettingsWrite = (user: CurrentUserIdentity, repository: RepositoryRow) =>
      Effect.gen(function* () {
        yield* requireSettings(user, repository.installation_id);
        if (repository.provider !== 'artifacts') yield* requireWrite(user, repository);
      });

    return {
      listInstallations: (user) =>
        Effect.gen(function* () {
          dependencies.defer(
            Promise.all(
              user.installationIds.map((installationId) =>
                syncInstallationRepos(installationId).catch((error) =>
                  console.warn(
                    `turbodiff: repo sync failed for installation ${installationId}`,
                    error,
                  ),
                ),
              ),
            ).then(() => undefined),
          );
          const [groups, agents, agentOverrides, skills, skillOverrides] = yield* dataOperation(
            () =>
              Promise.all([
                listInstallationsWithRepos(user.installationIds),
                listAgents(user.installationIds),
                listRepoAgentOverrides(user.installationIds),
                listSkills(user.installationIds),
                listRepoSkillOverrides(user.installationIds),
              ]),
          );
          dependencies.defer(
            Promise.all(
              user.installationIds.map((installationId) =>
                ensureBuiltinAgents(installationId).catch((error) =>
                  console.warn(
                    `turbodiff: agent repair failed for installation ${installationId}`,
                    error,
                  ),
                ),
              ),
            ).then(() => undefined),
          );
          const agentOverrideMap = new Map(
            agentOverrides.map((override) => [
              `${override.repository_id}:${override.agent_id}`,
              override.enabled,
            ]),
          );
          const skillOverrideMap = new Map(
            skillOverrides.map((override) => [
              `${override.repository_id}:${override.skill_id}`,
              override.enabled,
            ]),
          );
          return {
            githubAppSlug: dependencies.githubAppSlug,
            items: groups.map(({ installation, repos }) => {
              const installationAgents = agents.filter(
                (agent) => agent.installation_id === installation.id,
              );
              const installationSkills = skills.filter(
                (skill) => skill.installation_id === installation.id,
              );
              return {
                id: installation.id,
                accountLogin: installation.account_login,
                accountType: installation.account_type,
                suspended: installation.suspended,
                repositories: repos.map((repository) => ({
                  id: repository.id,
                  owner: repository.owner,
                  name: repository.name,
                  provider: repository.provider,
                  settings: serializeSettings(repository),
                  agents: installationAgents.map((agent) => ({
                    id: agent.id,
                    slug: agent.slug,
                    name: agent.name,
                    enabled: resolveAgentEnabled(
                      agent,
                      agentOverrideMap.get(`${repository.id}:${agent.id}`),
                    ),
                  })),
                  skills: installationSkills.map((skill) => ({
                    id: skill.id,
                    slug: skill.slug,
                    name: skill.name,
                    enabled: resolveSkillEnabled(
                      skillOverrideMap.get(`${repository.id}:${skill.id}`),
                    ),
                  })),
                })),
              };
            }),
          };
        }),
      createProject: (user, input) =>
        Effect.gen(function* () {
          if (!user.githubConnected || user.session.userId === 0) {
            return yield* Effect.fail(
              conflict('Connect a GitHub account first; project access is keyed to it'),
            );
          }
          const owner = input.owner.trim().toLowerCase();
          const name = input.name.trim();
          if (!PROJECT_SEGMENT.test(owner) || !PROJECT_SEGMENT.test(name)) {
            return yield* Effect.fail(
              badRequest(
                'owner and name must be 1-80 letters, digits, dots, dashes, or underscores',
              ),
            );
          }
          if (
            input.processProfile !== undefined &&
            !ADOPTABLE_PROCESS_PROFILE_KEYS.includes(input.processProfile)
          ) {
            return yield* Effect.fail(badRequest('Unknown process profile'));
          }
          if (yield* dataOperation(() => getRepoByFullName(owner, name))) {
            return yield* Effect.fail(conflict(`${owner}/${name} already exists`));
          }
          const project = yield* providerOperation(() =>
            createArtifactsProject({
              owner,
              name,
              description: input.description,
              creatorGithubId: user.session.userId,
              processProfile: input.processProfile,
            }),
          );
          return {
            repositoryId: project.repo.id,
            repository: `${project.repo.owner}/${project.repo.name}`,
            defaultBranch: project.repo.default_branch,
            remote: project.remote,
          };
        }),
      createCloneCredential: (user, id, scope) =>
        Effect.gen(function* () {
          const repository = yield* authorized(user, id);
          if (scope === 'write') yield* requireSettings(user, repository.installation_id);
          return yield* providerOperation(() => mintArtifactsCloneToken(repository, scope, 86_400));
        }),
      code: (user, id) =>
        Effect.gen(function* () {
          const repository = yield* authorized(user, id);
          const result = yield* providerOperation(() =>
            repository.provider === 'github'
              ? installationToken(repository.installation_id).then((token) =>
                  listBranchesAndDefault(token, repository),
                )
              : listBranchesAndDefaultArtifacts(repository),
          );
          return {
            repository: {
              id: repository.id,
              owner: repository.owner,
              name: repository.name,
              provider: repository.provider,
            },
            defaultBranch: result.default_branch,
            branches: result.branches,
          };
        }),
      tree: (user, id, ref, path) =>
        Effect.gen(function* () {
          const repository = yield* authorized(user, id);
          if (!isValidRepoRef(ref))
            return yield* Effect.fail(badRequest('A valid ref is required'));
          if (!isValidRepoPath(path)) return yield* Effect.fail(badRequest('Invalid path'));
          const tree =
            repository.provider === 'github'
              ? yield* providerOperation(() =>
                  installationToken(repository.installation_id).then((token) =>
                    readTree(token, repository, ref, path),
                  ),
                )
              : yield* dataOperation(() => repositoryRef(repository.id, ref)).pipe(
                  Effect.flatMap((recorded) =>
                    cached(
                      recorded
                        ? `artifacts/tree/${repository.id}/${recorded.head_sha}/${encodeURIComponent(path)}`
                        : null,
                      () => readTreeArtifacts(repository, ref, path),
                    ),
                  ),
                );
          return tree;
        }),
      file: (user, id, ref, path) =>
        Effect.gen(function* () {
          const repository = yield* authorized(user, id);
          if (!isValidRepoRef(ref))
            return yield* Effect.fail(badRequest('A valid ref is required'));
          if (!path || !isValidRepoPath(path))
            return yield* Effect.fail(badRequest('Invalid path'));
          const file =
            repository.provider === 'github'
              ? yield* providerOperation(() =>
                  installationToken(repository.installation_id).then((token) =>
                    readFile(token, repository, ref, path),
                  ),
                )
              : yield* dataOperation(() => repositoryRef(repository.id, ref)).pipe(
                  Effect.flatMap((recorded) =>
                    cached(
                      recorded
                        ? `artifacts/file/v2/${repository.id}/${recorded.head_sha}/${encodeURIComponent(path)}`
                        : null,
                      () => readFileArtifacts(repository, ref, path),
                    ),
                  ),
                );
          return serializeFile(file);
        }),
      saveFile: (user, id, input) =>
        Effect.gen(function* () {
          const repository = yield* authorized(user, id);
          const path = input.path.trim();
          const ref = input.ref.trim();
          if (!path || !isValidRepoPath(path))
            return yield* Effect.fail(badRequest('Invalid path'));
          if (!isValidRepoRef(ref))
            return yield* Effect.fail(badRequest('A valid ref is required'));
          if (new TextEncoder().encode(input.content).length > 1024 * 1024) {
            return yield* Effect.fail(badRequest('content must be at most 1 MB'));
          }
          if (repository.provider !== 'github' && input.mode === 'pull_request') {
            return yield* Effect.fail(
              badRequest('Pull-request saves are not available for hosted repositories'),
            );
          }
          yield* requireWrite(user, repository);
          const login = user.session.login || 'turbodiff';
          const common = {
            path,
            ref,
            base_sha: input.baseSha,
            content: input.content,
            message: input.message?.trim() || `Update ${path}`,
            author: { name: login, email: `${login}@users.noreply.github.com` },
          };
          const saved = yield* providerOperation(() =>
            repository.provider === 'github'
              ? sandboxGitToken(repository.installation_id, repository.name, 'write').then(
                  (token) =>
                    saveFile(token, repository, {
                      ...common,
                      mode: input.mode === 'pull_request' ? 'pr' : 'commit',
                    }),
                )
              : saveFileArtifacts(repository, common),
          );
          return {
            contentSha: saved.content_sha,
            commitSha: saved.commit_sha,
            branch: saved.branch,
            pullRequest: saved.pr,
          };
        }),
      updateSettings: (user, id, input) =>
        Effect.gen(function* () {
          const repository = yield* authorized(user, id);
          yield* requireSettingsWrite(user, repository);
          if (
            input.reviewPushDebounceMinutes !== undefined &&
            (input.reviewPushDebounceMinutes < 0 || input.reviewPushDebounceMinutes > 720)
          ) {
            return yield* Effect.fail(
              badRequest('reviewPushDebounceMinutes must be between 0 and 720'),
            );
          }
          if (
            input.processProfile !== undefined &&
            !ADOPTABLE_PROCESS_PROFILE_KEYS.includes(input.processProfile)
          ) {
            return yield* Effect.fail(badRequest('Unknown process profile'));
          }
          yield* dataOperation(async () => {
            const writes: Promise<void>[] = [];
            if (input.enabled !== undefined) writes.push(setRepoEnabled(id, input.enabled));
            if (input.reviewOnPush !== undefined) {
              writes.push(setRepoReviewOnPush(id, input.reviewOnPush));
            }
            if (input.reviewPushDebounceMinutes !== undefined) {
              writes.push(setRepoReviewPushDebounceMinutes(id, input.reviewPushDebounceMinutes));
            }
            if (input.processProfile !== undefined) {
              writes.push(setRepoProcessProfile(id, input.processProfile));
            }
            if (input.blockingReviews !== undefined) {
              writes.push(setRepoBlockingReviews(id, input.blockingReviews));
            }
            if (input.autoFix !== undefined) writes.push(setRepoAutoFix(id, input.autoFix));
            if (input.autoMerge !== undefined) writes.push(setRepoAutoMerge(id, input.autoMerge));
            if (input.autoResolveConflicts !== undefined) {
              writes.push(setRepoAutoResolveConflicts(id, input.autoResolveConflicts));
            }
            if (input.demoVideos !== undefined) {
              writes.push(setRepoDemoVideos(id, input.demoVideos));
            }
            if (input.checkCommand !== undefined) {
              writes.push(setRepoCheckCommand(id, input.checkCommand));
            }
            await Promise.all(writes);
          });
          const updated = yield* dataOperation(() => getRepoById(id));
          if (!updated) return yield* Effect.fail(notFound('Unknown repository'));
          return serializeSettings(updated);
        }),
      setAgentEnabled: (user, repositoryId, agentId, enabled) =>
        Effect.gen(function* () {
          const repository = yield* authorized(user, repositoryId);
          yield* requireSettingsWrite(user, repository);
          const agent = yield* dataOperation(() => getAgentById(agentId));
          if (!agent || agent.installation_id !== repository.installation_id) {
            return yield* Effect.fail(notFound('Unknown agent'));
          }
          yield* dataOperation(() => setRepoAgentEnabled(repositoryId, agentId, enabled));
        }),
      setSkillEnabled: (user, repositoryId, skillId, enabled) =>
        Effect.gen(function* () {
          const repository = yield* authorized(user, repositoryId);
          yield* requireSettingsWrite(user, repository);
          const skill = yield* dataOperation(() => getSkillById(skillId));
          if (!skill || skill.installation_id !== repository.installation_id) {
            return yield* Effect.fail(notFound('Unknown skill'));
          }
          yield* dataOperation(() => setRepoSkillEnabled(repositoryId, skillId, enabled));
        }),
    } satisfies RepositoryOperations;
  }),
);
