import { getSandbox, type Sandbox, type SandboxOptions } from '@cloudflare/sandbox';
import { env } from 'cloudflare:workers';

export function runnerSandbox(id: string, options?: SandboxOptions): Sandbox {
  // SAFETY: wrangler.jsonc binds this namespace to @cloudflare/sandbox's
  // Sandbox class; generated Worker types cannot retain that class parameter.
  const namespace = env.Sandbox as DurableObjectNamespace<Sandbox>;
  return getSandbox(namespace, id, options);
}
