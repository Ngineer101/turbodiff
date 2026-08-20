import { env } from 'cloudflare:workers';
import { DEFAULT_RUNNER_MODEL } from '../../shared/runner-models.ts';

export type RunnerAuthMode = 'claude_subscription' | 'gateway';

export interface RunnerAuth {
  mode: RunnerAuthMode;
  // Secrets: callers must redact these from surfaced output.
  vars: Record<string, string>;
  // Non-secret runner configuration, kept separate so model ids are not redacted.
  config: Record<string, string>;
}

export function resolveRunnerAuth(requested?: RunnerAuthMode, model?: string | null): RunnerAuth {
  const config = { ANTHROPIC_MODEL: model?.trim() || DEFAULT_RUNNER_MODEL };
  const subscriptionToken = (env.CLAUDE_CODE_OAUTH_TOKEN ?? '').trim();
  const gatewayKey = (env.FIXER_ANTHROPIC_API_KEY ?? '').trim();
  const gatewayUrl = (env.FIXER_ANTHROPIC_BASE_URL ?? '').trim();

  const subscription = subscriptionToken
    ? {
        mode: 'claude_subscription' as const,
        vars: { CLAUDE_CODE_OAUTH_TOKEN: subscriptionToken },
      }
    : null;
  const gateway =
    gatewayKey && gatewayUrl
      ? {
          mode: 'gateway' as const,
          vars: { ANTHROPIC_BASE_URL: gatewayUrl, ANTHROPIC_API_KEY: gatewayKey },
        }
      : null;

  if (requested === 'claude_subscription' && !subscription) {
    throw new Error('claude_subscription mode requires the CLAUDE_CODE_OAUTH_TOKEN secret');
  }
  if (requested === 'gateway' && !gateway) {
    throw new Error(
      'gateway mode requires the FIXER_ANTHROPIC_API_KEY secret and FIXER_ANTHROPIC_BASE_URL var',
    );
  }
  const picked = requested === 'gateway' ? gateway : (subscription ?? gateway);
  if (!picked) {
    throw new Error(
      'no runner credential configured: set CLAUDE_CODE_OAUTH_TOKEN (subscription) or FIXER_ANTHROPIC_API_KEY + FIXER_ANTHROPIC_BASE_URL (gateway)',
    );
  }
  return { ...picked, config };
}

export function runnerEnvironment(auth: RunnerAuth, extra: Record<string, string> = {}) {
  return {
    ...auth.vars,
    ...auth.config,
    IS_SANDBOX: '1',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ...extra,
  };
}
