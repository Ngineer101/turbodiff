import type { Sandbox } from '@cloudflare/sandbox';
import type { RepositoryRow } from '../../data/db.ts';
import { resolveWorkspaceRemote } from '../../integrations/git/provider.ts';
import type { WorkspaceRemote } from '../../integrations/git/remotes.ts';
import { redactSecrets } from './redaction.ts';
import { prepareFullMirror } from './repository-workspace.ts';
import { generationSandbox } from './sandbox.ts';

// The native change-request engine (docs/artifacts-provider.md): the forge
// capabilities GitHub normally provides, computed with real git in the
// sandbox against the provider-resolved remote. Merge-base + diff feed the
// CR record and review, a --no-commit dry-run answers "would this merge",
// and --no-ff merge + push is the merge button. Validated by the Phase-0.5
// spike (branch artifacts-phase0-spike); this is the production port.

// Branch names are interpolated into sandbox commands — nothing outside this
// set may pass. Slash allowed for turbodiff/feat-n.
export const CR_BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,80}$/;

export interface CrFileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  // null for binary files (git numstat prints "-").
  additions: number | null;
  deletions: number | null;
}

export interface CrComputation {
  sourceHead: string;
  targetHead: string;
  mergeBase: string;
  mergeable: boolean;
  conflictFiles: string[];
  files: CrFileChange[];
  patch: string;
  patchTruncated: boolean;
}

export interface CrMergeResult {
  mergedHead: string;
}

const PATCH_CAP = 512 * 1024;
// Rides the same per-repo container as generation/verification, so the
// container is usually warm when a CR needs computing; its own directory
// keeps CR state out of the shared repo cache.
export const CR_DIR = '/workspace/cr-workspace';

interface GitContext {
  sandbox: Sandbox;
  remote: WorkspaceRemote;
}

function assertBranches(...branches: string[]): void {
  for (const branch of branches) {
    if (!CR_BRANCH_NAME.test(branch) || branch.includes('..')) {
      throw new Error(`branch must match ${CR_BRANCH_NAME}`);
    }
  }
}

function crSandbox(repo: RepositoryRow): Sandbox {
  return generationSandbox(repo);
}

async function git(ctx: GitContext, command: string, timeoutMs = 2 * 60_000): Promise<string> {
  const result = await ctx.sandbox.exec(command, {
    env: ctx.remote.env,
    timeout: timeoutMs,
  });
  if (!result.success) {
    throw new Error(
      redactSecrets(result.stderr || result.stdout, [ctx.remote.token]).slice(0, 500),
    );
  }
  return result.stdout;
}

// Workspace sync lives with the other credential-bearing command shapes in
// repository-workspace.ts; the engine only owns diff/merge mechanics.
async function syncWorkspace(ctx: GitContext): Promise<void> {
  await prepareFullMirror(ctx.sandbox, CR_DIR, ctx.remote);
}

// Everything a CR record shows about its diff: heads, merge-base, per-file
// stats, the unified patch, and a real dry-run answer to "would this merge".
export async function computeCrState(
  repo: RepositoryRow,
  source: string,
  target: string,
): Promise<CrComputation> {
  assertBranches(source, target);
  const remote = await resolveWorkspaceRemote(repo, 'read');
  const ctx: GitContext = { sandbox: crSandbox(repo), remote };
  await syncWorkspace(ctx);

  const sourceRef = `refs/remotes/origin/${source}`;
  const targetRef = `refs/remotes/origin/${target}`;
  const heads = await git(
    ctx,
    `git -C ${CR_DIR} rev-parse ${targetRef} ${sourceRef} && ` +
      `git -C ${CR_DIR} merge-base ${targetRef} ${sourceRef}`,
  );
  const [targetHead = '', sourceHead = '', mergeBase = ''] = heads.trim().split('\n');
  if (!mergeBase) throw new Error(`could not resolve ${source}/${target} heads or merge-base`);

  const stats = await git(
    ctx,
    `git -C ${CR_DIR} diff --numstat ${mergeBase} ${sourceRef} && echo @@SPLIT@@ && ` +
      `git -C ${CR_DIR} diff --name-status ${mergeBase} ${sourceRef}`,
  );
  const files = parseFileChanges(stats);

  const rawPatch = await git(ctx, `git -C ${CR_DIR} diff ${mergeBase} ${sourceRef}`);
  const patchTruncated = rawPatch.length > PATCH_CAP;
  const patch = patchTruncated ? rawPatch.slice(0, PATCH_CAP) : rawPatch;

  const { mergeable, conflictFiles } = await mergeDryRun(ctx, sourceRef, targetRef);

  return {
    sourceHead,
    targetHead,
    mergeBase,
    mergeable,
    conflictFiles,
    files,
    patch,
    patchTruncated,
  };
}

async function resetMergeState(ctx: GitContext): Promise<void> {
  await git(ctx, `cd ${CR_DIR} && (git merge --abort 2>/dev/null || true) && git reset -q --hard`);
}

async function mergeDryRun(
  ctx: GitContext,
  sourceRef: string,
  targetRef: string,
): Promise<{ mergeable: boolean; conflictFiles: string[] }> {
  const attempt = await ctx.sandbox.exec(
    `cd ${CR_DIR} && git checkout -q --detach ${targetRef} && ` +
      `git merge --no-commit --no-ff -q ${sourceRef}`,
    { env: ctx.remote.env, timeout: 2 * 60_000 },
  );
  let conflictFiles: string[] = [];
  if (!attempt.success) {
    const unmerged = await git(ctx, `git -C ${CR_DIR} diff --name-only --diff-filter=U`);
    conflictFiles = unmerged.trim().split('\n').filter(Boolean);
  }
  // A clean --no-commit merge and a conflicted one both leave merge state.
  await resetMergeState(ctx);
  if (!attempt.success && conflictFiles.length === 0) {
    // The merge failed for some reason other than content conflicts.
    throw new Error(
      redactSecrets(attempt.stderr || attempt.stdout, [ctx.remote.token]).slice(0, 500),
    );
  }
  return { mergeable: attempt.success, conflictFiles };
}

// The merge button: --no-ff merge in the sandbox, pushed with a write-scoped
// credential. Fails with git's own conflict output rather than pushing a
// broken tree.
export async function mergeCr(
  repo: RepositoryRow,
  source: string,
  target: string,
  message: string,
): Promise<CrMergeResult> {
  assertBranches(source, target);
  const resolved = await resolveWorkspaceRemote(repo, 'write');
  // The merge message travels via env like every other run-scoped value —
  // titles may legally contain characters the shell would evaluate.
  const remote: WorkspaceRemote = {
    ...resolved,
    env: { ...resolved.env, CR_MERGE_MSG: message },
  };
  const ctx: GitContext = { sandbox: crSandbox(repo), remote };
  await syncWorkspace(ctx);

  try {
    const out = await git(
      ctx,
      `cd ${CR_DIR} && git checkout -q -B cr-merge refs/remotes/origin/${target} && ` +
        `git merge --no-ff -q refs/remotes/origin/${source} -m "$CR_MERGE_MSG" && ` +
        `git ${remote.configFlags} push -q "${remote.authUrl}" cr-merge:refs/heads/${target} && ` +
        `git rev-parse HEAD`,
      3 * 60_000,
    );
    const mergedHead = out.trim().split('\n').pop() ?? '';
    if (!mergedHead) throw new Error('merge push succeeded but no head was reported');
    return { mergedHead };
  } catch (err) {
    // Leave no half-merged state behind for the next engine call.
    await resetMergeState(ctx).catch(() => {});
    throw err;
  }
}

function parseFileChanges(raw: string): CrFileChange[] {
  const [numstatBlock = '', nameStatusBlock = ''] = raw.split('@@SPLIT@@');
  const counts = new Map<string, { additions: number | null; deletions: number | null }>();
  for (const line of numstatBlock.trim().split('\n')) {
    if (!line) continue;
    const [additions = '', deletions = '', ...rest] = line.split('\t');
    counts.set(rest.join('\t'), {
      additions: additions === '-' ? null : Number(additions),
      deletions: deletions === '-' ? null : Number(deletions),
    });
  }
  const files: CrFileChange[] = [];
  for (const line of nameStatusBlock.trim().split('\n')) {
    if (!line) continue;
    const [code = '', ...paths] = line.split('\t');
    const path = paths[paths.length - 1] ?? '';
    if (!path) continue;
    const status = code.startsWith('R')
      ? 'renamed'
      : code === 'A'
        ? 'added'
        : code === 'D'
          ? 'deleted'
          : 'modified';
    const count = counts.get(path) ?? counts.get(paths[0] ?? '');
    files.push({ path, status, ...(count ?? { additions: null, deletions: null }) });
  }
  return files;
}
