import type { Sandbox } from '@cloudflare/sandbox';
import type { WorkspaceRemote } from '../../integrations/git/remotes.ts';
import { redactSecrets } from './redaction.ts';

// Every runner's workspace prep lives here so the credential rules hold in
// exactly one place: tokens only ever travel via env to explicit-URL
// commands, cache remotes are rewritten to credential-free URLs, and a
// corrupted warm cache is dropped rather than allowed to wedge future runs.
// Which forge the repo lives on is the remote's concern (git/provider.ts);
// this module only shapes commands around it.

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
  remote: WorkspaceRemote;
  base: string;
  // With `branch` set, a fresh work branch is created off base's FETCH_HEAD
  // (generation/automation). Without it, `base` is an existing remote branch:
  // it is force-fetched into the cache's refs without touching the cache's
  // checked-out branch (so runs sharing the cache aren't disturbed) and the
  // worktree is cloned directly onto it (verification).
  branch?: string;
  // Extra secrets to scrub from surfaced git errors, beyond the remote token.
  secrets?: string[];
}

// Refreshes one credential-free repository cache, then creates an isolated
// local worktree for a run.
export async function prepareCachedWorktree({
  sandbox,
  cacheDir,
  workDir,
  remote,
  base,
  branch,
  secrets = [],
}: PrepareCachedWorktreeOptions): Promise<void> {
  const scrub = (s: string) => redactSecrets(s, [remote.token, ...secrets]);
  const git = `git ${remote.configFlags}`;
  const warmFetch = branch
    ? `${git} -C ${cacheDir} fetch --depth 50 "${remote.authUrl}" "$BASE_REF" && ` +
      `git -C ${cacheDir} checkout -q -B "$BASE_REF" FETCH_HEAD; `
    : `${git} -C ${cacheDir} fetch --depth 50 "${remote.authUrl}" "+refs/heads/$BASE_REF:refs/heads/$BASE_REF"; `;
  const sync = await sandbox.exec(
    `if [ -d ${cacheDir}/.git ]; then ` +
      warmFetch +
      `else ${git} clone --depth 50 --single-branch --branch "$BASE_REF" ` +
      `"${remote.authUrl}" ${cacheDir} && ` +
      `git -C ${cacheDir} remote set-url origin "${remote.cleanUrl}"; fi`,
    { env: { ...remote.env, BASE_REF: base }, timeout: 5 * 60_000 },
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
  remote: WorkspaceRemote;
  branch: string;
  secrets?: string[];
}

// Fresh shallow single-branch checkout for runs that work directly on an
// existing PR branch (fix, conflict resolution). Whatever the clone left in
// .git/config (GitHub's URL embeds the token) is stripped before anything
// else runs in the checkout, because the agent and the repo's own check
// command both execute untrusted repo content with network egress; later
// fetches/pushes supply the token via env to explicit-URL commands instead.
export async function prepareFreshClone({
  sandbox,
  cloneDir,
  remote,
  branch,
  secrets = [],
}: PrepareFreshCloneOptions): Promise<void> {
  const clone = await sandbox.exec(
    `rm -rf ${cloneDir} && git ${remote.configFlags} clone --depth 50 --single-branch ` +
      `--branch "$WORK_BRANCH" "${remote.authUrl}" ${cloneDir}`,
    { env: { ...remote.env, WORK_BRANCH: branch }, timeout: 5 * 60_000 },
  );
  if (!clone.success) {
    throw new Error(
      `git clone failed: ${redactSecrets(clone.stderr, [remote.token, ...secrets]).slice(0, 500)}`,
    );
  }
  await sandbox.exec(
    `git -C ${cloneDir} remote set-url origin "${remote.cleanUrl}" && ` + botIdentity(cloneDir),
  );
}

// The push counterpart of the prepare helpers: HEAD of `dir` to the branch
// named by `$PUSH_BRANCH` (env-supplied by the caller alongside remote.env).
export function pushHeadCommand(remote: WorkspaceRemote, dir: string): string {
  return `git ${remote.configFlags} -C ${dir} push "${remote.authUrl}" HEAD:"$PUSH_BRANCH"`;
}

export async function worktreeChanged(sandbox: Sandbox, workDir: string): Promise<boolean> {
  const status = await sandbox.exec(`git -C ${workDir} status --porcelain`);
  return Boolean(status.stdout.trim());
}
