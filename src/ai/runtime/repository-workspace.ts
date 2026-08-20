import type { Sandbox } from '@cloudflare/sandbox';
import { redactSecrets } from './redaction.ts';

interface PrepareCachedWorktreeOptions {
  sandbox: Sandbox;
  cacheDir: string;
  workDir: string;
  repository: string;
  base: string;
  branch: string;
  gitToken: string;
}

// Refreshes one credential-free repository cache, then creates an isolated
// local worktree for a generation or automation run.
export async function prepareCachedWorktree({
  sandbox,
  cacheDir,
  workDir,
  repository,
  base,
  branch,
  gitToken,
}: PrepareCachedWorktreeOptions): Promise<void> {
  const sync = await sandbox.exec(
    `if [ -d ${cacheDir}/.git ]; then ` +
      `git -C ${cacheDir} fetch --depth 50 "https://x-access-token:$GIT_TOKEN@github.com/${repository}.git" "$BASE_REF" && ` +
      `git -C ${cacheDir} checkout -q -B "$BASE_REF" FETCH_HEAD; ` +
      `else git clone --depth 50 --single-branch --branch "$BASE_REF" ` +
      `"https://x-access-token:$GIT_TOKEN@github.com/${repository}.git" ${cacheDir} && ` +
      `git -C ${cacheDir} remote set-url origin "https://github.com/${repository}.git"; fi`,
    { env: { GIT_TOKEN: gitToken, BASE_REF: base }, timeout: 5 * 60_000 },
  );
  if (!sync.success) {
    // Never let one corrupted warm cache wedge future runs.
    await sandbox.exec(`rm -rf ${cacheDir}`).catch(() => {});
    throw new Error(
      `repo cache sync failed: ${redactSecrets(sync.stderr, [gitToken]).slice(0, 500)}`,
    );
  }

  const clone = await sandbox.exec(
    `rm -rf ${workDir} && git clone --local ${cacheDir} ${workDir} && ` +
      `git -C ${workDir} checkout -q -b "$WORK_BRANCH" && ` +
      `git -C ${workDir} config user.name "turbodiff[bot]" && ` +
      `git -C ${workDir} config user.email "turbodiff[bot]@users.noreply.github.com"`,
    { env: { WORK_BRANCH: branch }, timeout: 2 * 60_000 },
  );
  if (!clone.success) {
    throw new Error(`working-copy clone failed: ${clone.stderr.slice(0, 500)}`);
  }
}

export async function worktreeChanged(sandbox: Sandbox, workDir: string): Promise<boolean> {
  const status = await sandbox.exec(`git -C ${workDir} status --porcelain`);
  return Boolean(status.stdout.trim());
}
