import { env } from 'cloudflare:workers';
import { redactSecrets } from '../runtime/redaction.ts';
import { runnerSandbox } from '../runtime/sandbox.ts';

// Phase-0.5 Artifacts CR engine (docs/artifacts-cr-spike.md): prototype of
// the mechanic the native change-request layer stands on. Artifacts is a bare
// git remote — no diff, merge, or PR API — so every CR capability here is
// computed with real git in the sandbox: merge-base + diff for review, a
// --no-commit dry-run for mergeability, --no-ff merge + push for the merge
// button. Per-step timings are the spike's primary output: they decide
// whether production CRs can afford sandbox git per refresh or need
// isomorphic-git in the Worker.

export const CR_REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// Branch names are interpolated into sandbox commands like repo names are —
// nothing outside this set may pass. Slash allowed for turbodiff/feat-n.
export const CR_BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,80}$/;

export interface CrTiming {
  step: string;
  ms: number;
  detail?: string;
}

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
  timings: CrTiming[];
}

export interface CrMergeResult {
  mergedHead: string;
  timings: CrTiming[];
}

const PATCH_CAP = 256 * 1024;
const WORKSPACES = '/tmp/artifacts-cr';
// Shares the phase-0 spike's sandbox instance so both reuse a warm container.
export const CR_SANDBOX_ID = 'artifacts-spike';
// Same credential rules as repository-workspace.ts: tokens only travel via
// env into explicit-URL/extraHeader git commands, never into .git/config.
const AUTH = '-c http.extraHeader="Authorization: Bearer $GIT_TOKEN"';

interface GitContext {
  sandbox: ReturnType<typeof runnerSandbox>;
  dir: string;
  execEnv: Record<string, string>;
  secrets: string[];
}

function assertNames(repo: string, ...branches: string[]): void {
  if (!CR_REPO_NAME.test(repo)) throw new Error(`repo must match ${CR_REPO_NAME}`);
  for (const branch of branches) {
    if (!CR_BRANCH_NAME.test(branch) || branch.includes('..')) {
      throw new Error(`branch must match ${CR_BRANCH_NAME}`);
    }
  }
}

async function timedStep<T>(
  timings: CrTiming[],
  step: string,
  run: () => Promise<T>,
  detail?: (value: T) => string,
): Promise<T> {
  const started = Date.now();
  const value = await run();
  const timing: CrTiming = { step, ms: Date.now() - started };
  if (detail) timing.detail = detail(value);
  timings.push(timing);
  return value;
}

async function git(ctx: GitContext, command: string, timeoutMs = 2 * 60_000): Promise<string> {
  const result = await ctx.sandbox.exec(command, { env: ctx.execEnv, timeout: timeoutMs });
  if (!result.success) {
    throw new Error(redactSecrets(result.stderr || result.stdout, ctx.secrets).slice(0, 500));
  }
  return result.stdout;
}

async function gitContext(repo: string, scope: 'read' | 'write'): Promise<[GitContext, CrTiming]> {
  const started = Date.now();
  const handle = await env.GIT_ARTIFACTS.get(repo);
  const token = await handle.createToken(scope, 900);
  return [
    {
      sandbox: runnerSandbox(CR_SANDBOX_ID),
      dir: `${WORKSPACES}/${repo}`,
      execEnv: { GIT_TOKEN: token.plaintext, REMOTE: handle.remote },
      secrets: [token.plaintext],
    },
    { step: `mint ${scope} token (binding)`, ms: Date.now() - started },
  ];
}

// Clone on first touch, fetch after — the cold/warm split in the timing
// detail is exactly the number the production diff-cache design needs.
// (The very first exec additionally pays the container boot.)
async function syncWorkspace(ctx: GitContext, timings: CrTiming[]): Promise<void> {
  await timedStep(
    timings,
    'sync workspace (clone or fetch)',
    () =>
      git(
        ctx,
        `mkdir -p ${WORKSPACES} && if [ -d ${ctx.dir}/.git ]; then ` +
          `git -C ${ctx.dir} ${AUTH} fetch -q --prune "$REMOTE" "+refs/heads/*:refs/remotes/origin/*" && echo warm; ` +
          `else git ${AUTH} clone -q "$REMOTE" ${ctx.dir} && echo cold; fi`,
        5 * 60_000,
      ),
    (out) => `${out.trim().split('\n').pop()} workspace`,
  );
}

// Everything a CR record shows about its diff: heads, merge-base, per-file
// stats, the unified patch, and a real dry-run answer to "would this merge".
export async function computeCrState(
  repo: string,
  source: string,
  target: string,
): Promise<CrComputation> {
  assertNames(repo, source, target);
  const timings: CrTiming[] = [];
  const [ctx, mintTiming] = await gitContext(repo, 'read');
  timings.push(mintTiming);
  await syncWorkspace(ctx, timings);

  const sourceRef = `refs/remotes/origin/${source}`;
  const targetRef = `refs/remotes/origin/${target}`;
  const heads = await timedStep(timings, 'resolve heads + merge-base', () =>
    git(
      ctx,
      `git -C ${ctx.dir} rev-parse ${targetRef} ${sourceRef} && ` +
        `git -C ${ctx.dir} merge-base ${targetRef} ${sourceRef}`,
    ),
  );
  const [targetHead = '', sourceHead = '', mergeBase = ''] = heads.trim().split('\n');
  if (!mergeBase) throw new Error(`could not resolve ${source}/${target} heads or merge-base`);

  const stats = await timedStep(timings, 'diff stats', () =>
    git(
      ctx,
      `git -C ${ctx.dir} diff --numstat ${mergeBase} ${sourceRef} && echo @@SPLIT@@ && ` +
        `git -C ${ctx.dir} diff --name-status ${mergeBase} ${sourceRef}`,
    ),
  );
  const files = parseFileChanges(stats);

  const rawPatch = await timedStep(
    timings,
    'diff patch',
    () => git(ctx, `git -C ${ctx.dir} diff ${mergeBase} ${sourceRef}`),
    (out) => `${out.length} bytes`,
  );
  const patchTruncated = rawPatch.length > PATCH_CAP;
  const patch = patchTruncated ? rawPatch.slice(0, PATCH_CAP) : rawPatch;

  const { mergeable, conflictFiles } = await timedStep(
    timings,
    'mergeability dry-run',
    () => mergeDryRun(ctx, sourceRef, targetRef),
    (outcome) =>
      outcome.mergeable ? 'clean' : `conflicts in ${outcome.conflictFiles.length} file(s)`,
  );

  return {
    sourceHead,
    targetHead,
    mergeBase,
    mergeable,
    conflictFiles,
    files,
    patch,
    patchTruncated,
    timings,
  };
}

async function mergeDryRun(
  ctx: GitContext,
  sourceRef: string,
  targetRef: string,
): Promise<{ mergeable: boolean; conflictFiles: string[] }> {
  const attempt = await ctx.sandbox.exec(
    `cd ${ctx.dir} && git checkout -q --detach ${targetRef} && ` +
      `git merge --no-commit --no-ff -q ${sourceRef}`,
    { env: ctx.execEnv, timeout: 2 * 60_000 },
  );
  let conflictFiles: string[] = [];
  if (!attempt.success) {
    const unmerged = await git(ctx, `git -C ${ctx.dir} diff --name-only --diff-filter=U`);
    conflictFiles = unmerged.trim().split('\n').filter(Boolean);
  }
  // A clean --no-commit merge and a conflicted one both leave merge state.
  await git(ctx, `cd ${ctx.dir} && (git merge --abort 2>/dev/null || true) && git reset -q --hard`);
  if (!attempt.success && conflictFiles.length === 0) {
    // The merge failed for some reason other than content conflicts.
    throw new Error(redactSecrets(attempt.stderr || attempt.stdout, ctx.secrets).slice(0, 500));
  }
  return { mergeable: attempt.success, conflictFiles };
}

// The merge button: --no-ff merge in the sandbox, pushed with a write token.
// Fails (with git's own conflict output) rather than pushing a broken tree.
export async function mergeCr(
  repo: string,
  source: string,
  target: string,
  message: string,
): Promise<CrMergeResult> {
  assertNames(repo, source, target);
  const timings: CrTiming[] = [];
  const [ctx, mintTiming] = await gitContext(repo, 'write');
  timings.push(mintTiming);
  ctx.execEnv.GIT_MSG = message;
  await syncWorkspace(ctx, timings);

  try {
    const out = await timedStep(
      timings,
      'merge --no-ff + push',
      () =>
        git(
          ctx,
          `cd ${ctx.dir} && git checkout -q -B cr-merge refs/remotes/origin/${target} && ` +
            `git config user.name "turbodiff[bot]" && git config user.email "bot@turbodiff.dev" && ` +
            `git merge --no-ff -q refs/remotes/origin/${source} -m "$GIT_MSG" && ` +
            `git ${AUTH} push -q "$REMOTE" cr-merge:refs/heads/${target} && git rev-parse HEAD`,
          3 * 60_000,
        ),
      (result) => `head=${result.trim().split('\n').pop()}`,
    );
    const mergedHead = out.trim().split('\n').pop() ?? '';
    if (!mergedHead) throw new Error('merge push succeeded but no head was reported');
    return { mergedHead, timings };
  } catch (err) {
    // Leave no half-merged state behind for the next engine call.
    await ctx.sandbox
      .exec(`cd ${ctx.dir} && (git merge --abort 2>/dev/null || true) && git reset -q --hard`, {
        env: ctx.execEnv,
      })
      .catch(() => {});
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
