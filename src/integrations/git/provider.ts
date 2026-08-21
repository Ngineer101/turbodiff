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

// Remote URLs are derived from config, not read off the repo handle: the
// closed-beta binding's handle neither serializes its `remote` property
// (RpcProperty) nor serves it as an RPC fetch ("receiver does not implement
// the method"). The format is deterministic per namespace.
export function artifactsRemoteUrl(artifactsRepo: string): string {
  const base = (env.ARTIFACTS_REMOTE_BASE ?? '').trim().replace(/\/+$/, '');
  if (!base) {
    throw new Error(
      'ARTIFACTS_REMOTE_BASE is not configured — set it in wrangler.jsonc vars ' +
        '(see: npx wrangler artifacts repos get)',
    );
  }
  return `${base}/${artifactsRepo}.git`;
}

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
    return artifactsWorkspaceRemote(artifactsRemoteUrl(repo.artifacts_repo), token.plaintext);
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
