import type { Sandbox } from '@cloudflare/sandbox';
import { redactSecrets } from '../ai/runtime/redaction.ts';
import { prepareFullMirror } from '../ai/runtime/repository-workspace.ts';
import { generationSandbox } from '../ai/runtime/sandbox.ts';
import type { RepositoryRow } from '../data/db.ts';
import { resolveWorkspaceRemote } from '../integrations/git/provider.ts';
import type { WorkspaceRemote } from '../integrations/git/remotes.ts';
import type { ApiFileSave, ApiRepoFile, ApiRepoTree } from '../shared/api-types.ts';
import { parseLsTreeZ } from './ls-tree.ts';
import {
  decodeBase64Text,
  isValidRepoPath,
  isValidRepoRef,
  RepoBrowserError,
  sortTreeEntries,
  type SaveFileInput,
} from './repo-browser.ts';

// The Artifacts sibling of repo-browser.ts: Artifacts has no contents REST
// API, so the same ApiRepoTree/ApiRepoFile/ApiFileSave contracts are computed
// with real git in the warm per-repo sandbox against a full mirror — the CR
// engine's established pattern (ai/runtime/cr-engine.ts). User-influenced
// values (ref, path, message, author) only ever travel via env vars
// referenced as "$VAR" in command strings; file content goes through
// sandbox.writeFile, never through env or the command string.

// Its own mirror, NOT the CR engine's /workspace/cr-workspace: the engine
// checks out and hard-resets that directory, and the browser's saves mutate
// this one. Same container, separate directories.
export const BROWSE_DIR = '/workspace/code-browse';

// Mirror the GitHub adapter's 1 MB too_large semantics.
const FILE_CAP = 1024 * 1024;

interface BrowseContext {
  sandbox: Sandbox;
  // null on the fresh-mirror fast path: reads are local git operations that
  // need no credentials, so no token is minted and no fetch runs.
  remote: WorkspaceRemote | null;
}

// A read within this window of the last sync skips the remote fetch (and
// the per-request token mint) entirely — clicking through a tree is many
// reads against the same seconds-old mirror. Writes always resync.
const MIRROR_FRESH_SECONDS = 30;
// Inside .git so the worktree stays clean for the save path's `git add`.
const SYNC_MARKER = `${BROWSE_DIR}/.git/turbodiff-synced-at`;

// Every public function starts here: clone on first touch, fetch --prune
// after (the CR engine's sync pattern) — but at most once per freshness
// window for reads. The marker file carries the last sync's epoch seconds.
async function browseContext(repo: RepositoryRow, scope: 'read' | 'write'): Promise<BrowseContext> {
  if (repo.provider !== 'artifacts') {
    throw new Error(`${repo.owner}/${repo.name} is not an Artifacts-hosted repo`);
  }
  const sandbox = generationSandbox(repo);
  if (scope === 'read') {
    const probe = await sandbox.exec(
      `now=$(date +%s); ts=$(cat ${SYNC_MARKER} 2>/dev/null || echo 0); ` +
        `[ $((now - ts)) -lt ${MIRROR_FRESH_SECONDS} ] && echo fresh || echo stale`,
    );
    if (probe.success && probe.stdout.trim() === 'fresh') {
      return { sandbox, remote: null };
    }
  }
  const remote = await resolveWorkspaceRemote(repo, scope);
  await prepareFullMirror(sandbox, BROWSE_DIR, remote);
  await sandbox.exec(`date +%s > ${SYNC_MARKER}`).catch(() => {});
  return { sandbox, remote };
}

async function git(
  ctx: BrowseContext,
  command: string,
  extraEnv: Record<string, string> = {},
  timeoutMs = 2 * 60_000,
): Promise<string> {
  const result = await ctx.sandbox.exec(command, {
    env: { ...ctx.remote?.env, ...extraEnv },
    timeout: timeoutMs,
  });
  if (!result.success) {
    throw new Error(
      redactSecrets(result.stderr || result.stdout, ctx.remote ? [ctx.remote.token] : []).slice(
        0,
        500,
      ),
    );
  }
  return result.stdout;
}

// The routes gate ref/path already; re-asserted here so a future caller
// can't reach a sandbox exec with an unvetted value.
function assertRefAndPath(ref: string, path: string): void {
  if (!isValidRepoRef(ref)) throw new RepoBrowserError('a valid ref is required', 400);
  if (!isValidRepoPath(path)) throw new RepoBrowserError('invalid path', 400);
}

export async function listBranchesAndDefaultArtifacts(
  repo: RepositoryRow,
): Promise<{ default_branch: string | null; branches: string[] }> {
  const ctx = await browseContext(repo, 'read');
  const out = await git(
    ctx,
    `git -C ${BROWSE_DIR} for-each-ref --format='%(refname:strip=3)' refs/remotes/origin`,
  );
  const branches = out
    .split('\n')
    .map((line) => line.trim())
    // HEAD is the clone's origin/HEAD symref, not a branch.
    .filter((name) => name && name !== 'HEAD')
    .sort((a, b) => a.localeCompare(b));
  // default_branch is set at Artifacts project creation; fall back for rows
  // that somehow predate it.
  return { default_branch: repo.default_branch ?? branches[0] ?? null, branches };
}

export async function readTreeArtifacts(
  repo: RepositoryRow,
  ref: string,
  path: string,
): Promise<ApiRepoTree> {
  assertRefAndPath(ref, path);
  const ctx = await browseContext(repo, 'read');
  let out: string;
  try {
    // Empty path ⇒ `rev:` ⇒ the root tree. -z gives NUL-separated records
    // with unquoted names, so filenames with spaces/quotes parse safely —
    // but exec stdout is not binary-safe (NUL bytes are stripped, which
    // used to collapse the whole listing into one garbage entry), so the
    // records ship out as base64, same as cat-file below. The temp file
    // keeps ls-tree's exit code and stderr as the command's own (a plain
    // pipe would report base64's), and $$ keeps concurrent reads apart.
    out = await git(
      ctx,
      `git -C ${BROWSE_DIR} ls-tree -l -z "refs/remotes/origin/$BROWSE_REF:$BROWSE_PATH" > "/tmp/browse-tree.$$" && ` +
        `base64 < "/tmp/browse-tree.$$" | tr -d '\\n' && rm -f "/tmp/browse-tree.$$"`,
      { BROWSE_REF: ref, BROWSE_PATH: path },
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (detail.includes('not a tree object')) {
      throw new RepoBrowserError('path is a file, not a directory', 400);
    }
    if (
      detail.includes('Not a valid object name') ||
      detail.includes('unknown revision') ||
      detail.includes('does not exist in')
    ) {
      throw new RepoBrowserError('unknown ref or path', 400);
    }
    throw err;
  }
  const raw = decodeBase64Text(out.trim());
  if (raw === null) {
    // A filename that isn't valid UTF-8 can't round-trip through the JSON
    // API contract at all.
    throw new RepoBrowserError('directory listing is not valid UTF-8', 400);
  }
  const entries = parseLsTreeZ(raw, path);
  sortTreeEntries(entries);
  return { path, entries };
}

export async function readFileArtifacts(
  repo: RepositoryRow,
  ref: string,
  path: string,
): Promise<ApiRepoFile> {
  assertRefAndPath(ref, path);
  if (!path) throw new RepoBrowserError('invalid path', 400);
  const ctx = await browseContext(repo, 'read');
  const spec = `"refs/remotes/origin/$BROWSE_REF:$BROWSE_PATH"`;
  const refEnv = { BROWSE_REF: ref, BROWSE_PATH: path };
  let stat: string;
  try {
    stat = await git(
      ctx,
      `git -C ${BROWSE_DIR} rev-parse ${spec} && ` +
        `git -C ${BROWSE_DIR} cat-file -t ${spec} && ` +
        `git -C ${BROWSE_DIR} cat-file -s ${spec}`,
      refEnv,
    );
  } catch {
    throw new RepoBrowserError('file not found on this ref', 400);
  }
  const [sha = '', type = '', sizeRaw = ''] = stat
    .trim()
    .split('\n')
    .map((line) => line.trim());
  if (type === 'tree') throw new RepoBrowserError('path is a directory, not a file', 400);
  if (type !== 'blob') {
    // Submodule (commit) entries have no text to show — render as binary.
    return { path, ref, sha, size: 0, text: null, binary: true, too_large: false };
  }
  const size = Number(sizeRaw);
  if (size > FILE_CAP) {
    return { path, ref, sha, size, text: null, binary: false, too_large: true };
  }
  // Exec stdout is not binary-safe, so ship the blob out as base64
  // (`tr -d '\n'` rather than the GNU-only `base64 -w 0`).
  const b64 = await git(
    ctx,
    `git -C ${BROWSE_DIR} cat-file blob ${spec} | base64 | tr -d '\\n'`,
    refEnv,
  );
  const text = decodeBase64Text(b64.trim());
  return { path, ref, sha, size, text, binary: text === null, too_large: false };
}

const STALE_SAVE = 'file changed on the branch since you opened it — reload and reapply your edit';

export async function saveFileArtifacts(
  repo: RepositoryRow,
  input: Omit<SaveFileInput, 'mode'>,
): Promise<ApiFileSave> {
  if (!isValidRepoRef(input.ref)) throw new RepoBrowserError('a valid ref is required', 400);
  if (!input.path || !isValidRepoPath(input.path)) {
    throw new RepoBrowserError('invalid path', 400);
  }
  const ctx = await browseContext(repo, 'write');
  // SAFETY: scope 'write' never takes the fresh-mirror fast path, so the
  // remote is always resolved.
  const remote = ctx.remote!;
  const refEnv = { BROWSE_REF: input.ref, BROWSE_PATH: input.path };

  // base_sha is the optimistic-concurrency token, exactly as on GitHub. A
  // failed rev-parse is the expected outcome for new files, hence raw exec.
  const current = await ctx.sandbox.exec(
    `git -C ${BROWSE_DIR} rev-parse "refs/remotes/origin/$BROWSE_REF:$BROWSE_PATH"`,
    { env: { ...remote.env, ...refEnv } },
  );
  if (input.base_sha !== null) {
    if (!current.success || current.stdout.trim() !== input.base_sha) {
      throw new RepoBrowserError(STALE_SAVE, 409);
    }
  } else if (current.success) {
    throw new RepoBrowserError('the file already exists on this branch — reload it first', 409);
  }

  // A dedicated edit branch in the browser's own dir, so mutating the
  // worktree is safe; concurrent reads only touch refs/remotes/origin/*.
  try {
    await git(
      ctx,
      `cd ${BROWSE_DIR} && git checkout -q -B code-edit "refs/remotes/origin/$BROWSE_REF"`,
      refEnv,
    );
  } catch {
    throw new RepoBrowserError('unknown ref', 400);
  }

  try {
    await git(ctx, `mkdir -p "$(dirname -- "$BROWSE_TARGET")"`, {
      BROWSE_TARGET: `${BROWSE_DIR}/${input.path}`,
    });
    await ctx.sandbox.writeFile(`${BROWSE_DIR}/${input.path}`, input.content);
    const out = await git(
      ctx,
      `cd ${BROWSE_DIR} && git add -- "$BROWSE_PATH" && git commit -q -m "$EDIT_MSG" && ` +
        `git ${remote.configFlags} push -q "${remote.authUrl}" code-edit:"refs/heads/$BROWSE_REF" && ` +
        `git rev-parse HEAD && git rev-parse "HEAD:$BROWSE_PATH"`,
      {
        ...refEnv,
        EDIT_MSG: input.message,
        GIT_AUTHOR_NAME: input.author.name,
        GIT_AUTHOR_EMAIL: input.author.email,
        GIT_COMMITTER_NAME: input.author.name,
        GIT_COMMITTER_EMAIL: input.author.email,
      },
      3 * 60_000,
    );
    const lines = out.trim().split('\n');
    const contentSha = lines.pop()?.trim() ?? '';
    const commitSha = lines.pop()?.trim() ?? '';
    if (!commitSha || !contentSha) {
      throw new Error('save push succeeded but no shas were reported');
    }
    // No extra event plumbing: the push fires ArtifactsEventsWorkflow
    // (last_push_at, CR refresh, review-on-push) like any other push.
    return {
      ok: true,
      content_sha: contentSha,
      commit_sha: commitSha,
      branch: input.ref,
      pr: null,
    };
  } catch (err) {
    // Leave no half-committed state behind for the next browse/save.
    await ctx.sandbox.exec(`cd ${BROWSE_DIR} && git reset -q --hard`).catch(() => {});
    const detail = err instanceof Error ? err.message : String(err);
    // A push race that slipped past the staleness check maps to the same 409.
    if (/non-fast-forward|fetch first|\[rejected\]/.test(detail)) {
      throw new RepoBrowserError(STALE_SAVE, 409);
    }
    if (detail.includes('nothing to commit')) {
      throw new RepoBrowserError('no changes to save', 400);
    }
    throw err;
  }
}
