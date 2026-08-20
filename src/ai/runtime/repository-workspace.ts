import type { Sandbox } from '@cloudflare/sandbox';
import { redactSecrets } from './redaction.ts';

// Every runner's workspace prep lives here so the credential rules hold in
// exactly one place: tokens only ever travel via env to explicit-URL
// commands, cache remotes are rewritten to credential-free URLs, and a
// corrupted warm cache is dropped rather than allowed to wedge future runs.

function botIdentity(dir: string): string {
  return (
    `git -C ${dir} config user.name "turbodiff[bot]" && ` +
    `git -C ${dir} config user.email "turbodiff[bot]@users.noreply.github.com"`
  );
}

interface PrepareCachedWorktreeOptions {
  sandbox: Sandbox;
  cacheDir: string;
  workDir: string;
  repository: string;
  base: string;
  // With `branch` set, a fresh work branch is created off base's FETCH_HEAD
  // (generation/automation). Without it, `base` is an existing remote branch:
  // it is force-fetched into the cache's refs without touching the cache's
  // checked-out branch (so runs sharing the cache aren't disturbed) and the
  // worktree is cloned directly onto it (verification).
  branch?: string;
  gitToken: string;
  // Extra secrets to scrub from surfaced git errors, beyond the git token.
  secrets?: string[];
}

// Refreshes one credential-free repository cache, then creates an isolated
// local worktree for a run.
export async function prepareCachedWorktree({
  sandbox,
  cacheDir,
  workDir,
  repository,
  base,
  branch,
  gitToken,
  secrets = [],
}: PrepareCachedWorktreeOptions): Promise<void> {
  const scrub = (s: string) => redactSecrets(s, [gitToken, ...secrets]);
  const warmFetch = branch
    ? `git -C ${cacheDir} fetch --depth 50 "https://x-access-token:$GIT_TOKEN@github.com/${repository}.git" "$BASE_REF" && ` +
      `git -C ${cacheDir} checkout -q -B "$BASE_REF" FETCH_HEAD; `
    : `git -C ${cacheDir} fetch --depth 50 "https://x-access-token:$GIT_TOKEN@github.com/${repository}.git" "+refs/heads/$BASE_REF:refs/heads/$BASE_REF"; `;
  const sync = await sandbox.exec(
    `if [ -d ${cacheDir}/.git ]; then ` +
      warmFetch +
      `else git clone --depth 50 --single-branch --branch "$BASE_REF" ` +
      `"https://x-access-token:$GIT_TOKEN@github.com/${repository}.git" ${cacheDir} && ` +
      `git -C ${cacheDir} remote set-url origin "https://github.com/${repository}.git"; fi`,
    { env: { GIT_TOKEN: gitToken, BASE_REF: base }, timeout: 5 * 60_000 },
  );
  if (!sync.success) {
    // Never let one corrupted warm cache wedge future runs.
    await sandbox.exec(`rm -rf ${cacheDir}`).catch(() => {});
    throw new Error(`repo cache sync failed: ${scrub(sync.stderr).slice(0, 500)}`);
  }

  const cloneCommand = branch
    ? `rm -rf ${workDir} && git clone --local ${cacheDir} ${workDir} && ` +
      `git -C ${workDir} checkout -q -b "$WORK_BRANCH" && ${botIdentity(workDir)}`
    : `rm -rf ${workDir} && git clone --local ${cacheDir} ${workDir} -b "$WORK_BRANCH" && ` +
      botIdentity(workDir);
  const clone = await sandbox.exec(cloneCommand, {
    env: { WORK_BRANCH: branch ?? base },
    timeout: 2 * 60_000,
  });
  if (!clone.success) {
    throw new Error(`working-copy clone failed: ${scrub(clone.stderr).slice(0, 500)}`);
  }
}

interface PrepareFreshCloneOptions {
  sandbox: Sandbox;
  cloneDir: string;
  repository: string;
  branch: string;
  gitToken: string;
  secrets?: string[];
}

// Fresh shallow single-branch checkout for runs that work directly on an
// existing PR branch (fix, conflict resolution). The clone URL (token
// included) lands in .git/config — it is stripped before anything else runs
// in the checkout, because the agent and the repo's own check command both
// execute untrusted repo content with network egress; later fetches/pushes
// supply the token via env to explicit-URL commands instead.
export async function prepareFreshClone({
  sandbox,
  cloneDir,
  repository,
  branch,
  gitToken,
  secrets = [],
}: PrepareFreshCloneOptions): Promise<void> {
  const clone = await sandbox.exec(
    `rm -rf ${cloneDir} && git clone --depth 50 --single-branch --branch "$WORK_BRANCH" ` +
      `"https://x-access-token:$GIT_TOKEN@github.com/${repository}.git" ${cloneDir}`,
    { env: { GIT_TOKEN: gitToken, WORK_BRANCH: branch }, timeout: 5 * 60_000 },
  );
  if (!clone.success) {
    throw new Error(
      `git clone failed: ${redactSecrets(clone.stderr, [gitToken, ...secrets]).slice(0, 500)}`,
    );
  }
  await sandbox.exec(
    `git -C ${cloneDir} remote set-url origin "https://github.com/${repository}.git" && ` +
      botIdentity(cloneDir),
  );
}

export async function worktreeChanged(sandbox: Sandbox, workDir: string): Promise<boolean> {
  const status = await sandbox.exec(`git -C ${workDir} status --porcelain`);
  return Boolean(status.stdout.trim());
}
