import { env } from 'cloudflare:workers';
import type { RepositoryRow } from '../../data/db.ts';
import { sandboxGitToken } from '../github/app.ts';
import {
  artifactsWorkspaceRemote,
  githubWorkspaceRemote,
  type WorkspaceRemote,
} from './remotes.ts';

// Runtime half of the git-provider seam (docs/artifacts-provider.md): mints
// run-scoped credentials and dispatches on the repo row's provider. The pure
// remote builders live in ./remotes.ts.

export {
  ARTIFACTS_NAMESPACE,
  artifactsWorkspaceRemote,
  deriveArtifactsRepoName,
  factoryUnsupportedReason,
  githubWorkspaceRemote,
  type GitProviderKind,
  type WorkspaceRemote,
} from './remotes.ts';

// TTL for per-run sandbox credentials. Generous enough for a long agent run
// that pushes at the end; far below the 24h default.
const ARTIFACTS_TOKEN_TTL_SECONDS = 4 * 3600;

// The subset of RepositoryRow the resolver needs; workflow RunContexts carry
// this shape so a step can resolve a remote without re-reading the repo row.
export interface RemoteSource {
  provider: string;
  installation_id: number;
  owner: string;
  name: string;
  artifacts_repo: string | null;
}

// Mints a run-scoped credential and returns the remote for the repo's
// provider. GitHub `workflows` widening only applies to GitHub tokens.
export async function resolveWorkspaceRemote(
  repo: RemoteSource,
  scope: 'read' | 'write',
  opts?: { workflows?: boolean },
): Promise<WorkspaceRemote> {
  if (repo.provider === 'artifacts') {
    if (!repo.artifacts_repo) {
      throw new Error(`${repo.owner}/${repo.name} is an artifacts repo without artifacts_repo set`);
    }
    const handle = await env.GIT_ARTIFACTS.get(repo.artifacts_repo);
    const token = await handle.createToken(scope, ARTIFACTS_TOKEN_TTL_SECONDS);
    // Workers RPC: stub properties are lazy thenables despite the generated
    // string type — an unawaited one poisons any later serialization
    // boundary ("Could not serialize object of type RpcProperty").
    // Promise.resolve assimilates the thenable without tripping lint.
    const remoteUrl = await Promise.resolve(handle.remote);
    return artifactsWorkspaceRemote(remoteUrl, token.plaintext);
  }
  const token = await sandboxGitToken(repo.installation_id, repo.name, scope, opts);
  return githubWorkspaceRemote(`${repo.owner}/${repo.name}`, token);
}

export function remoteSourceOf(repo: RepositoryRow): RemoteSource {
  return {
    provider: repo.provider,
    installation_id: repo.installation_id,
    owner: repo.owner,
    name: repo.name,
    artifacts_repo: repo.artifacts_repo,
  };
}
