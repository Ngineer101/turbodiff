import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from '@effect/platform';
import { Schema } from 'effect';
import { DomainError } from './errors.ts';

const PositiveInt = Schema.Int.pipe(Schema.positive());
const repositoryId = HttpApiSchema.param(
  'repositoryId',
  Schema.NumberFromString.pipe(Schema.int(), Schema.positive()),
);
const agentId = HttpApiSchema.param(
  'agentId',
  Schema.NumberFromString.pipe(Schema.int(), Schema.positive()),
);
const skillId = HttpApiSchema.param(
  'skillId',
  Schema.NumberFromString.pipe(Schema.int(), Schema.positive()),
);
const withDomainErrors = <
  Name extends string,
  Method extends 'GET' | 'POST' | 'PUT',
  Path,
  UrlParams,
  Payload,
  Headers,
  Success,
  Error,
  R,
  RE,
>(
  endpoint: HttpApiEndpoint.HttpApiEndpoint<
    Name,
    Method,
    Path,
    UrlParams,
    Payload,
    Headers,
    Success,
    Error,
    R,
    RE
  >,
) => endpoint.addError(DomainError);

const ProcessProfile = Schema.Literal(
  'review_on_demand',
  'automatic_review',
  'review_and_repair',
  'idea_to_pr',
  'assisted_delivery',
  'full_delivery',
  'native_turnkey',
);

export const CreateProject = Schema.Struct({
  owner: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  processProfile: Schema.optional(ProcessProfile),
});
export type CreateProject = typeof CreateProject.Type;

export const Project = Schema.Struct({
  repositoryId: PositiveInt,
  repository: Schema.String,
  defaultBranch: Schema.NullOr(Schema.String),
  remote: Schema.String,
});
export type Project = typeof Project.Type;

export const CloneCredentialRequest = Schema.Struct({ scope: Schema.Literal('read', 'write') });
export const CloneCredential = Schema.Struct({
  remote: Schema.String,
  token: Schema.String,
  scope: Schema.Literal('read', 'write'),
  expiresAt: Schema.String,
});
export type CloneCredential = typeof CloneCredential.Type;

export const RepositoryCode = Schema.Struct({
  repository: Schema.Struct({
    id: PositiveInt,
    owner: Schema.String,
    name: Schema.String,
    provider: Schema.String,
  }),
  defaultBranch: Schema.NullOr(Schema.String),
  branches: Schema.Array(Schema.String),
});
export type RepositoryCode = typeof RepositoryCode.Type;

export const RepositoryTreeQuery = Schema.Struct({
  ref: Schema.String,
  path: Schema.optional(Schema.String),
});
export const RepositoryTree = Schema.Struct({
  path: Schema.String,
  entries: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      path: Schema.String,
      type: Schema.Literal('dir', 'file', 'symlink', 'submodule'),
      size: Schema.NullOr(Schema.Number),
      sha: Schema.String,
    }),
  ),
});
export type RepositoryTree = typeof RepositoryTree.Type;

export const RepositoryFileQuery = Schema.Struct({ ref: Schema.String, path: Schema.String });
export const RepositoryFile = Schema.Struct({
  path: Schema.String,
  ref: Schema.String,
  sha: Schema.String,
  size: Schema.Number,
  text: Schema.NullOr(Schema.String),
  binary: Schema.Boolean,
  tooLarge: Schema.Boolean,
  contentBase64: Schema.NullOr(Schema.String),
});
export type RepositoryFile = typeof RepositoryFile.Type;

export const SaveRepositoryFile = Schema.Struct({
  path: Schema.String,
  ref: Schema.String,
  baseSha: Schema.NullOr(Schema.String),
  content: Schema.String,
  message: Schema.optional(Schema.String),
  mode: Schema.Literal('commit', 'pull_request'),
});
export type SaveRepositoryFile = typeof SaveRepositoryFile.Type;

export const SavedRepositoryFile = Schema.Struct({
  contentSha: Schema.String,
  commitSha: Schema.String,
  branch: Schema.String,
  pullRequest: Schema.NullOr(Schema.Struct({ number: PositiveInt, url: Schema.String })),
});
export type SavedRepositoryFile = typeof SavedRepositoryFile.Type;

export const RepositorySettings = Schema.Struct({
  id: PositiveInt,
  enabled: Schema.Boolean,
  reviewOnPush: Schema.Boolean,
  reviewPushDebounceMinutes: Schema.Int,
  processProfile: ProcessProfile,
  blockingReviews: Schema.Boolean,
  autoFix: Schema.Boolean,
  autoMerge: Schema.Boolean,
  autoResolveConflicts: Schema.Boolean,
  demoVideos: Schema.Boolean,
  checkCommand: Schema.NullOr(Schema.String),
});
export type RepositorySettings = typeof RepositorySettings.Type;

export const UpdateRepositorySettings = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  reviewOnPush: Schema.optional(Schema.Boolean),
  reviewPushDebounceMinutes: Schema.optional(Schema.Int),
  processProfile: Schema.optional(ProcessProfile),
  blockingReviews: Schema.optional(Schema.Boolean),
  autoFix: Schema.optional(Schema.Boolean),
  autoMerge: Schema.optional(Schema.Boolean),
  autoResolveConflicts: Schema.optional(Schema.Boolean),
  demoVideos: Schema.optional(Schema.Boolean),
  checkCommand: Schema.optional(Schema.String),
});
export type UpdateRepositorySettings = typeof UpdateRepositorySettings.Type;

export const EnableResource = Schema.Struct({ enabled: Schema.Boolean });

const ToggleResource = Schema.Struct({
  id: PositiveInt,
  slug: Schema.String,
  name: Schema.String,
  enabled: Schema.Boolean,
});
export const InstallationCollection = Schema.Struct({
  githubAppSlug: Schema.String,
  items: Schema.Array(
    Schema.Struct({
      id: PositiveInt,
      accountLogin: Schema.String,
      accountType: Schema.String,
      suspended: Schema.Boolean,
      repositories: Schema.Array(
        Schema.Struct({
          id: PositiveInt,
          owner: Schema.String,
          name: Schema.String,
          provider: Schema.String,
          settings: RepositorySettings,
          agents: Schema.Array(ToggleResource),
          skills: Schema.Array(ToggleResource),
        }),
      ),
    }),
  ),
});
export type InstallationCollection = typeof InstallationCollection.Type;

export const RepositoriesApi = HttpApiGroup.make('repositories')
  .add(
    HttpApiEndpoint.get('listInstallations', '/installations')
      .addSuccess(InstallationCollection)
      .addError(DomainError),
  )
  .add(
    withDomainErrors(
      HttpApiEndpoint.post('createProject', '/projects')
        .setPayload(CreateProject)
        .addSuccess(Project, { status: 201 }),
    ),
  )
  .add(
    withDomainErrors(
      HttpApiEndpoint.post('createCloneCredential')`/repositories/${repositoryId}/clone-credentials`
        .setPayload(CloneCredentialRequest)
        .addSuccess(CloneCredential, { status: 201 }),
    ),
  )
  .add(
    withDomainErrors(
      HttpApiEndpoint.get('getRepositoryCode')`/repositories/${repositoryId}/code`.addSuccess(
        RepositoryCode,
      ),
    ),
  )
  .add(
    withDomainErrors(
      HttpApiEndpoint.get('getRepositoryTree')`/repositories/${repositoryId}/tree`
        .setUrlParams(RepositoryTreeQuery)
        .addSuccess(RepositoryTree),
    ),
  )
  .add(
    withDomainErrors(
      HttpApiEndpoint.get('getRepositoryFile')`/repositories/${repositoryId}/files`
        .setUrlParams(RepositoryFileQuery)
        .addSuccess(RepositoryFile),
    ),
  )
  .add(
    withDomainErrors(
      HttpApiEndpoint.put('saveRepositoryFile')`/repositories/${repositoryId}/files`
        .setPayload(SaveRepositoryFile)
        .addSuccess(SavedRepositoryFile),
    ),
  )
  .add(
    HttpApiEndpoint.patch('updateRepositorySettings')`/repositories/${repositoryId}`
      .setPayload(UpdateRepositorySettings)
      .addSuccess(RepositorySettings)
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.put('setRepositoryAgent')`/repositories/${repositoryId}/agents/${agentId}`
      .setPayload(EnableResource)
      .addSuccess(HttpApiSchema.NoContent, { status: 204 })
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.put('setRepositorySkill')`/repositories/${repositoryId}/skills/${skillId}`
      .setPayload(EnableResource)
      .addSuccess(HttpApiSchema.NoContent, { status: 204 })
      .addError(DomainError),
  );
