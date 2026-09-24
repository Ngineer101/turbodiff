import { getSandbox, type Sandbox, type SandboxOptions } from '@cloudflare/sandbox';
import { env } from 'cloudflare:workers';
import { sandboxRetryDisposition } from './sandbox-retry.ts';

export { retrySandboxOperation } from './sandbox-retry.ts';

export function runnerSandbox(id: string, options?: SandboxOptions): Sandbox {
  // SAFETY: wrangler.jsonc binds this namespace to @cloudflare/sandbox's
  // Sandbox class; generated Worker types cannot retain that class parameter.
  const namespace = env.Sandbox as DurableObjectNamespace<Sandbox>;
  return getSandbox(namespace, id, options);
}

// Callers running inside a Workflow step rethrow retryable infrastructure
// failures instead of recording them as business outcomes.
export function isSandboxTransportError<Failure>(failure: Failure): boolean {
  return sandboxRetryDisposition(failure) !== 'none';
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
