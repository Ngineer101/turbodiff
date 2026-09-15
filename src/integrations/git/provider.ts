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
      'ARTIFACTS_REMOTE_BASE is not configured — set the Worker variable in Cloudflare ' +
        '(see: npx wrangler artifacts repos get)',
    );
  }
  return `${base}/${artifactsRepo}.git`;
}

// The subset of RepositoryRow the resolver needs; workflow RunContexts carry
// this shape so a step can resolve a remote without re-reading the repo row.
export interface RemoteSource {
  source_provider: string;
  source_external_account_id: string | null;
  owner: string;
  name: string;
  external_id: string | null;
}

// Mints a run-scoped credential and returns the remote for the repo's
// provider. GitHub `workflows` widening only applies to GitHub tokens.
export async function resolveWorkspaceRemote(
  repo: RemoteSource,
  scope: 'read' | 'write',
  opts?: { workflows?: boolean },
): Promise<WorkspaceRemote> {
  if (repo.source_provider === 'artifacts') {
    if (!repo.external_id) {
      throw new Error(`${repo.owner}/${repo.name} has no Artifacts repository identifier`);
    }
    const handle = await env.GIT_ARTIFACTS.get(repo.external_id);
    const token = await handle.createToken(scope, ARTIFACTS_TOKEN_TTL_SECONDS);
    return artifactsWorkspaceRemote(artifactsRemoteUrl(repo.external_id), token.plaintext);
  }
  const installationId = Number(repo.source_external_account_id);
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    throw new Error(`${repo.owner}/${repo.name} has no GitHub installation identifier`);
  }
  const token = await sandboxGitToken(installationId, repo.name, scope, opts);
  return githubWorkspaceRemote(`${repo.owner}/${repo.name}`, token);
}

export function remoteSourceOf(repo: RepositoryRow): RemoteSource {
  return {
    source_provider: repo.source_provider,
    source_external_account_id: repo.source_external_account_id,
    owner: repo.owner,
    name: repo.name,
    external_id: repo.external_id,
  };
}
