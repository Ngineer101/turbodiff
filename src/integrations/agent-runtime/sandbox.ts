import { getSandbox, type Sandbox, type SandboxOptions } from '@cloudflare/sandbox';
import { env } from 'cloudflare:workers';

export function runnerSandbox(id: string, options?: SandboxOptions): Sandbox {
  // SAFETY: wrangler.jsonc binds this namespace to @cloudflare/sandbox's
  // Sandbox class; generated Worker types cannot retain that class parameter.
  const namespace = env.Sandbox as DurableObjectNamespace<Sandbox>;
  return getSandbox(namespace, id, options);
}

// The @cloudflare/sandbox client surfaces container-layer failures (instance
// scheduling, rollout kills, transient platform errors) as bare
// "HTTP error! status: 5xx" — infrastructure weather, not business outcomes.
// Callers running inside a Workflow step rethrow these so the step's
// configured retry engages instead of recording a permanent failure.
export function isSandboxTransportError<T>(err: T): boolean {
  return err instanceof Error && /HTTP error! status: 5\d\d/.test(err.message);
}

// The shared per-repo factory container: generation, verification, the CR
// engine, and CR review tools all ride the same instance so its repo and
// package caches stay warm across stages. The id string is load-bearing —
// a drifted spelling silently forfeits every warm cache.
export function generationSandbox(
  repo: { owner: string; name: string },
  options?: SandboxOptions,
): Sandbox {
  return runnerSandbox(`gen--${repo.owner}--${repo.name}`.toLowerCase(), {
    sleepAfter: '45m',
    ...options,
  });
}

// Hosted reviews get a dedicated per-repository container, separate from
// repository-changing factory runs. Individual agent worktrees live beneath
// it, so concurrent PRs/personas share package-manager caches without sharing
// mutable source trees.
export function reviewSandbox(repo: { owner: string; name: string }, options?: SandboxOptions) {
  return runnerSandbox(`review--${repo.owner}--${repo.name}`.toLowerCase(), {
    sleepAfter: '10m',
    ...options,
  });
}
