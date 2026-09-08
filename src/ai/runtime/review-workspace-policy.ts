import type { WorkspaceRemote } from '../../integrations/git/remotes.ts';

const HEAD_SHA = /^[0-9a-f]{40}$/i;
const SAFE_KEY = /[^a-z0-9._-]+/gi;

export function reviewWorkspacePath(agentInstanceId: string): string {
  const normalized = agentInstanceId.replaceAll(SAFE_KEY, '-');
  if (!normalized) throw new Error('review workspace requires a usable agent instance id');
  let hash = 2_166_136_261;
  for (const char of normalized) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  const key =
    normalized.length <= 180
      ? normalized
      : `${normalized.slice(0, 170)}-${(hash >>> 0).toString(16).padStart(8, '0')}`;
  return `/workspace/reviews/${key}`;
}

export function assertReviewHeadSha(headSha: string): string {
  if (!HEAD_SHA.test(headSha)) throw new Error(`invalid review head SHA: ${headSha}`);
  return headSha.toLowerCase();
}

// The pull-ref fetch works for same-repository and fork PRs. The credential is
// expanded from the exec environment in one command and is never configured
// as a git remote. `flock` serializes cold/warm refreshes for one persona while
// preserving the ignored dependency directory between calls.
export function reviewWorkspaceSyncCommand(workDir: string, remote: WorkspaceRemote): string {
  const lock = `${workDir}.lock`;
  return (
    `mkdir -p /workspace/reviews && flock -w 120 ${lock} bash -c '` +
    `trap "rm -f ${workDir}/.git/FETCH_HEAD" EXIT; ` +
    `if [ -d ${workDir}/.git ] && ` +
    `[ "$(git -C ${workDir} rev-parse HEAD 2>/dev/null)" = "$EXPECTED_HEAD" ]; then ` +
    `git -C ${workDir} reset --hard -q HEAD && git -C ${workDir} clean -ffdq; exit 0; fi; ` +
    `rm -rf ${workDir} && git init -q ${workDir} && ` +
    `git ${remote.configFlags} -C ${workDir} fetch -q --depth 50 "${remote.authUrl}" ` +
    `"+refs/pull/$PR_NUMBER/head:refs/remotes/origin/turbodiff-review" && ` +
    `git -C ${workDir} checkout -q --detach refs/remotes/origin/turbodiff-review && ` +
    `[ "$(git -C ${workDir} rev-parse HEAD)" = "$EXPECTED_HEAD" ] && ` +
    `git -C ${workDir} clean -ffdq'`
  );
}

export function assertRepositorySearchPath(path: string): string {
  if (path === '.') return path;
  if (
    path.length === 0 ||
    path.startsWith('/') ||
    path.startsWith('-') ||
    path.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`search path must stay inside the repository: ${path}`);
  }
  return path;
}
