import { HttpApiBuilder } from '@effect/platform';
import { Effect } from 'effect';
import { AppApi } from '../../contract/api.ts';
import { CurrentUser } from '../../contract/auth.ts';
import { RepositoryService } from './service.ts';

export const RepositoriesHandlers = HttpApiBuilder.group(
  AppApi,
  'repositories',
  Effect.fn(function* (handlers) {
    const service = yield* RepositoryService;
    return handlers
      .handle('listInstallations', () => Effect.flatMap(CurrentUser, service.listInstallations))
      .handle('createProject', ({ payload }) =>
        Effect.flatMap(CurrentUser, (user) => service.createProject(user, payload)),
      )
      .handle('createCloneCredential', ({ path, payload }) =>
        Effect.flatMap(CurrentUser, (user) =>
          service.createCloneCredential(user, path.repositoryId, payload.scope),
        ),
      )
      .handle('getRepositoryCode', ({ path }) =>
        Effect.flatMap(CurrentUser, (user) => service.code(user, path.repositoryId)),
      )
      .handle('getRepositoryTree', ({ path, urlParams }) =>
        Effect.flatMap(CurrentUser, (user) =>
          service.tree(user, path.repositoryId, urlParams.ref, urlParams.path ?? ''),
        ),
      )
      .handle('getRepositoryFile', ({ path, urlParams }) =>
        Effect.flatMap(CurrentUser, (user) =>
          service.file(user, path.repositoryId, urlParams.ref, urlParams.path),
        ),
      )
      .handle('saveRepositoryFile', ({ path, payload }) =>
        Effect.flatMap(CurrentUser, (user) => service.saveFile(user, path.repositoryId, payload)),
      )
      .handle('updateRepositorySettings', ({ path, payload }) =>
        Effect.flatMap(CurrentUser, (user) =>
          service.updateSettings(user, path.repositoryId, payload),
        ),
      )
      .handle('setRepositoryAgent', ({ path, payload }) =>
        Effect.flatMap(CurrentUser, (user) =>
          service.setAgentEnabled(user, path.repositoryId, path.agentId, payload.enabled),
        ),
      )
      .handle('setRepositorySkill', ({ path, payload }) =>
        Effect.flatMap(CurrentUser, (user) =>
          service.setSkillEnabled(user, path.repositoryId, path.skillId, payload.enabled),
        ),
      );
  }),
);
