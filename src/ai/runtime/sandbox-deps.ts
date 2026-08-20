import type { Sandbox } from '@cloudflare/sandbox';
// Shared AI runtime support for sandbox dependency installation.

// Shared package-manager caches inside the per-repo sandbox. The container's
// disk is wiped whenever it sleeps, so these are warm only within a
// sleepAfter window — but within it, every install across features hits the
// same cache.
export const NPM_CACHE_ENV = {
  npm_config_cache: '/workspace/.npm-cache',
  npm_config_store_dir: '/workspace/.pnpm-store',
};

const INSTALL_TIMEOUT_MS = 10 * 60_000;

// Install the checkout's dependencies so the agent can actually run the
// repo's check command while it works, instead of flying blind until the
// post-run check. Lockfile picks the tool; the frozen variant is tried first
// so a stale lockfile degrades to a plain install rather than failing the
// run. Returns the failure output (for a warning log) instead of throwing —
// some repos' check commands do their own install, so a failed preinstall
// must never kill the run.
export async function installDependencies(sandbox: Sandbox, dir: string): Promise<string | null> {
  const res = await sandbox.exec(
    `if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile || pnpm install; ` +
      `elif [ -f package-lock.json ]; then npm ci || npm install; ` +
      `elif [ -f package.json ]; then npm install; fi`,
    { cwd: dir, env: NPM_CACHE_ENV, timeout: INSTALL_TIMEOUT_MS },
  );
  return res.success ? null : `${res.stdout}\n${res.stderr}`.trim().slice(-500);
}
