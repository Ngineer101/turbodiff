import { Context, Effect, Layer } from 'effect';
import {
  getAgent,
  getIntegration,
  getRepository,
  getSkill,
  listAgents,
  listIntegrations,
  listRepositories,
  listRepositoryAgentIds,
  listRepositoryIntegrationIds,
  listRepositorySkillIds,
  listSkills,
  setRepositoryAgent,
  setRepositoryIntegration,
  setRepositorySkill,
  updateRepository,
  type RepositoryRow,
  type RepositorySettings as StoredRepositorySettings,
} from '../../../data/db.ts';
import {
  createArtifactsProject,
  mintArtifactsCloneToken,
} from '../../../application/repositories/artifacts.ts';
import { installationToken, sandboxGitToken } from '../../../integrations/github/app.ts';
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
import { isJsonObject, isBoolean, isString, type JsonObject } from '../../../shared/json.ts';
import { PROJECT_SEGMENT } from '../../../shared/projects.ts';
import type { CurrentUserIdentity } from '../../contract/auth.ts';
import type {
  CloneCredential,
  CreateRepository,
  CreatedRepository,
  RepositoryCode,
  RepositoryCollection,
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
  internalServerError,
  notFound,
  upstreamFailure,
  type DomainError,
} from '../../contract/errors.ts';
import { requireOrganizationWrite } from '../authorization.ts';

const DEFAULT_SETTINGS: Required<Pick<StoredRepositorySettings, 'reviewOnPush'>> = {
  reviewOnPush: false,
};

const dataEffect = <A>(run: () => Promise<A>): Effect.Effect<A, DomainError> =>
  Effect.tryPromise({
    try: run,
    catch: (failure) => {
      console.error('turbodiff: repository operation failed', failure);
      return internalServerError();
    },
  });

const providerEffect = <A>(run: () => Promise<A>): Effect.Effect<A, DomainError> =>
  Effect.tryPromise({
    try: run,
    catch: (failure) => {
      if (failure instanceof RepoBrowserError) {
        return failure.status === 409 ? conflict(failure.message) : badRequest(failure.message);
      }
      const detail = failure instanceof Error ? failure.message : 'Provider request failed';
      console.error('turbodiff: repository provider request failed', failure);
      return upstreamFailure(detail.slice(0, 500));
    },
  });

const githubInstallationId = (repository: RepositoryRow): Effect.Effect<number, DomainError> => {
  const value = Number(repository.source_external_account_id);
  return Number.isSafeInteger(value) && value > 0
    ? Effect.succeed(value)
    : Effect.fail(internalServerError());
};

const settingsOf = (repository: RepositoryRow): StoredRepositorySettings => {
  const value = isJsonObject(repository.settings) ? repository.settings : {};
  return {
    reviewOnPush: isBoolean(value.reviewOnPush)
      ? value.reviewOnPush
      : DEFAULT_SETTINGS.reviewOnPush,
    checkCommand: isString(value.checkCommand) ? value.checkCommand : undefined,
  };
};

const serializeSettings = (repository: RepositoryRow): RepositorySettings => {
  const settings = settingsOf(repository);
  return {
    id: repository.id,
    enabled: repository.enabled,
    reviewOnPush: settings.reviewOnPush ?? false,
    checkCommand: settings.checkCommand ?? null,
  };
};

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

const owned = (user: CurrentUserIdentity, id: number) =>
  dataEffect(() => getRepository(id)).pipe(
    Effect.flatMap((repository) =>
      repository && user.organizationIds.includes(repository.organization_id)
        ? Effect.succeed(repository)
        : Effect.fail(notFound('Unknown repository')),
    ),
  );

export interface RepositoryOperations {
  readonly list: (user: CurrentUserIdentity) => Effect.Effect<RepositoryCollection, DomainError>;
  readonly create: (
    user: CurrentUserIdentity,
    input: CreateRepository,
  ) => Effect.Effect<CreatedRepository, DomainError>;
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
  readonly setIntegrationEnabled: (
    user: CurrentUserIdentity,
    repositoryId: number,
    integrationId: number,
    enabled: boolean,
  ) => Effect.Effect<void, DomainError>;
}

export class RepositoryService extends Context.Tag('Turbodiff/RepositoryService')<
  RepositoryService,
  RepositoryOperations
>() {}

export const RepositoryServiceLive = Layer.succeed(RepositoryService, {
  list: (user) =>
    Effect.gen(function* () {
      const repositories = yield* dataEffect(() => listRepositories(user.organizationIds));
      const repositoryIds = repositories.map((repository) => repository.id);
      const [agents, skills, integrations, agentLinks, skillLinks, integrationLinks] =
        yield* dataEffect(() =>
          Promise.all([
            listAgents(user.organizationIds),
            listSkills(user.organizationIds),
            listIntegrations(user.organizationIds),
            listRepositoryAgentIds(repositoryIds),
            listRepositorySkillIds(repositoryIds),
            listRepositoryIntegrationIds(repositoryIds),
          ]),
        );
      const enabledAgents = new Set(
        agentLinks.map((link) => `${link.repository_id}:${link.agent_id}`),
      );
      const enabledSkills = new Set(
        skillLinks.map((link) => `${link.repository_id}:${link.skill_id}`),
      );
      const enabledIntegrations = new Set(
        integrationLinks.map((link) => `${link.repository_id}:${link.integration_id}`),
      );
      return {
        items: repositories.map((repository) => ({
          id: repository.id,
          organizationId: repository.organization_id,
          sourceIntegrationId: repository.source_integration_id,
          externalId: repository.external_id,
          owner: repository.owner,
          name: repository.name,
          defaultBranch: repository.default_branch,
          provider: repository.source_provider,
          settings: serializeSettings(repository),
          agents: agents
            .filter((agent) => agent.organization_id === repository.organization_id)
            .map((agent) => ({
              id: agent.id,
              slug: agent.slug,
              name: agent.name,
              enabled: enabledAgents.has(`${repository.id}:${agent.id}`),
            })),
          skills: skills
            .filter((skill) => skill.organization_id === repository.organization_id)
            .map((skill) => ({
              id: skill.id,
              slug: skill.slug,
              name: skill.name,
              enabled: enabledSkills.has(`${repository.id}:${skill.id}`),
            })),
          integrations: integrations
            .filter((integration) => integration.organization_id === repository.organization_id)
            .map((integration) => ({
              id: integration.id,
              kind: integration.kind,
              provider: integration.provider,
              name: integration.name,
              enabled: enabledIntegrations.has(`${repository.id}:${integration.id}`),
            })),
          createdAt: repository.created_at,
          updatedAt: repository.updated_at,
        })),
      };
    }),
  create: (user, input) =>
    Effect.gen(function* () {
      yield* requireOrganizationWrite(user, input.organizationId);
      const owner = input.owner.trim().toLowerCase();
      const name = input.name.trim();
      if (!PROJECT_SEGMENT.test(owner) || !PROJECT_SEGMENT.test(name)) {
        return yield* Effect.fail(badRequest('Repository owner or name is invalid'));
      }
      const project = yield* providerEffect(() =>
        createArtifactsProject({
          organizationId: input.organizationId,
          sourceIntegrationId: input.sourceIntegrationId,
          owner,
          name,
          description: input.description,
        }),
      );
      return {
        id: project.repo.id,
        organizationId: project.repo.organization_id,
        sourceIntegrationId: project.repo.source_integration_id,
        owner: project.repo.owner,
        name: project.repo.name,
        defaultBranch: project.repo.default_branch,
        provider: project.repo.source_provider,
        remote: project.remote,
      };
    }),
  createCloneCredential: (user, id, scope) =>
    Effect.gen(function* () {
      const repository = yield* owned(user, id);
      if (repository.source_provider !== 'artifacts') {
        return yield* Effect.fail(
          badRequest('Clone credentials are only issued for Artifacts repositories'),
        );
      }
      if (scope === 'write') yield* requireOrganizationWrite(user, repository.organization_id);
      return yield* providerEffect(() => mintArtifactsCloneToken(repository, scope, 86_400));
    }),
  code: (user, id) =>
    Effect.gen(function* () {
      const repository = yield* owned(user, id);
      const branchData =
        repository.source_provider === 'github'
          ? yield* githubInstallationId(repository).pipe(
              Effect.flatMap((installationId) =>
                providerEffect(() =>
                  installationToken(installationId).then((token) =>
                    listBranchesAndDefault(token, repository),
                  ),
                ),
              ),
            )
          : yield* providerEffect(() => listBranchesAndDefaultArtifacts(repository));
      return {
        repository: {
          id: repository.id,
          owner: repository.owner,
          name: repository.name,
          provider: repository.source_provider,
        },
        defaultBranch: branchData.default_branch,
        branches: branchData.branches,
      };
    }),
  tree: (user, id, ref, path) =>
    Effect.gen(function* () {
      const repository = yield* owned(user, id);
      if (!isValidRepoRef(ref)) return yield* Effect.fail(badRequest('A valid ref is required'));
      if (!isValidRepoPath(path)) return yield* Effect.fail(badRequest('Invalid path'));
      return repository.source_provider === 'github'
        ? yield* githubInstallationId(repository).pipe(
            Effect.flatMap((installationId) =>
              providerEffect(() =>
                installationToken(installationId).then((token) =>
                  readTree(token, repository, ref, path),
                ),
              ),
            ),
          )
        : yield* providerEffect(() => readTreeArtifacts(repository, ref, path));
    }),
  file: (user, id, ref, path) =>
    Effect.gen(function* () {
      const repository = yield* owned(user, id);
      if (!isValidRepoRef(ref)) return yield* Effect.fail(badRequest('A valid ref is required'));
      if (!path || !isValidRepoPath(path)) return yield* Effect.fail(badRequest('Invalid path'));
      const result =
        repository.source_provider === 'github'
          ? yield* githubInstallationId(repository).pipe(
              Effect.flatMap((installationId) =>
                providerEffect(() =>
                  installationToken(installationId).then((token) =>
                    readFile(token, repository, ref, path),
                  ),
                ),
              ),
            )
          : yield* providerEffect(() => readFileArtifacts(repository, ref, path));
      return serializeFile(result);
    }),
  saveFile: (user, id, input) =>
    Effect.gen(function* () {
      const repository = yield* owned(user, id);
      yield* requireOrganizationWrite(user, repository.organization_id);
      const path = input.path.trim();
      const ref = input.ref.trim();
      if (!path || !isValidRepoPath(path)) return yield* Effect.fail(badRequest('Invalid path'));
      if (!isValidRepoRef(ref)) return yield* Effect.fail(badRequest('A valid ref is required'));
      if (new TextEncoder().encode(input.content).length > 1024 * 1024) {
        return yield* Effect.fail(badRequest('content must be at most 1 MB'));
      }
      if (repository.source_provider !== 'github' && input.mode === 'pull_request') {
        return yield* Effect.fail(badRequest('Pull-request saves require a GitHub repository'));
      }
      const login = user.session.login ?? user.name;
      const common = {
        path,
        ref,
        base_sha: input.baseSha,
        content: input.content,
        message: input.message?.trim() || `Update ${path}`,
        author: { name: login, email: `${user.session.authUserId}@users.turbodiff.dev` },
      };
      const saved =
        repository.source_provider === 'github'
          ? yield* githubInstallationId(repository).pipe(
              Effect.flatMap((installationId) =>
                providerEffect(() =>
                  sandboxGitToken(installationId, repository.name, 'write').then((token) =>
                    saveFile(token, repository, {
                      ...common,
                      mode: input.mode === 'pull_request' ? 'pr' : 'commit',
                    }),
                  ),
                ),
              ),
            )
          : yield* providerEffect(() => saveFileArtifacts(repository, common));
      return {
        contentSha: saved.content_sha,
        commitSha: saved.commit_sha,
        branch: saved.branch,
        pullRequest: saved.pr,
      };
    }),
  updateSettings: (user, id, input) =>
    Effect.gen(function* () {
      const repository = yield* owned(user, id);
      yield* requireOrganizationWrite(user, repository.organization_id);
      const current = settingsOf(repository);
      const settings: JsonObject = {
        reviewOnPush: input.reviewOnPush ?? current.reviewOnPush ?? false,
      };
      const checkCommand = input.checkCommand ?? current.checkCommand;
      if (checkCommand !== undefined) settings.checkCommand = checkCommand;
      yield* dataEffect(() =>
        updateRepository(id, {
          enabled: input.enabled,
          settings,
        }),
      );
      const updated = yield* dataEffect(() => getRepository(id));
      if (!updated) return yield* Effect.fail(notFound('Unknown repository'));
      return serializeSettings(updated);
    }),
  setAgentEnabled: (user, repositoryId, agentId, enabled) =>
    Effect.gen(function* () {
      const repository = yield* owned(user, repositoryId);
      yield* requireOrganizationWrite(user, repository.organization_id);
      const agent = yield* dataEffect(() => getAgent(agentId));
      if (!agent || agent.organization_id !== repository.organization_id) {
        return yield* Effect.fail(notFound('Unknown agent'));
      }
      yield* dataEffect(() =>
        setRepositoryAgent(repository.id, agent.id, repository.organization_id, enabled),
      );
    }),
  setSkillEnabled: (user, repositoryId, skillId, enabled) =>
    Effect.gen(function* () {
      const repository = yield* owned(user, repositoryId);
      yield* requireOrganizationWrite(user, repository.organization_id);
      const skill = yield* dataEffect(() => getSkill(skillId));
      if (!skill || skill.organization_id !== repository.organization_id) {
        return yield* Effect.fail(notFound('Unknown skill'));
      }
      yield* dataEffect(() =>
        setRepositorySkill(repository.id, skill.id, repository.organization_id, enabled),
      );
    }),
  setIntegrationEnabled: (user, repositoryId, integrationId, enabled) =>
    Effect.gen(function* () {
      const repository = yield* owned(user, repositoryId);
      yield* requireOrganizationWrite(user, repository.organization_id);
      const integration = yield* dataEffect(() => getIntegration(integrationId));
      if (!integration || integration.organization_id !== repository.organization_id) {
        return yield* Effect.fail(notFound('Unknown integration'));
      }
      yield* dataEffect(() =>
        setRepositoryIntegration(
          repository.id,
          integration.id,
          repository.organization_id,
          enabled,
        ),
      );
    }),
} satisfies RepositoryOperations);
