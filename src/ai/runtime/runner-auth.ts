import { env } from 'cloudflare:workers';
import { resolveRunnerModel } from '../../data/models.ts';
import {
  AI_GATEWAY_GRANT_TTL_MS,
  createAiGatewayGrant,
} from '../../integrations/security/ai-gateway-grant.ts';

import type { RunnerAuth } from './runner-config.ts';

export type RunnerAuthMode = 'claude_subscription' | 'gateway';
export type { RunnerAuth } from './runner-config.ts';

export async function resolveRunnerAuth(
  requested?: RunnerAuthMode,
  model?: string | null,
): Promise<RunnerAuth> {
  if (requested === 'claude_subscription') {
    throw new Error(
      'claude_subscription runner mode is no longer supported; configure the model-neutral AI Gateway runner',
    );
  }
  const accountId = (env.AI_GATEWAY_ACCOUNT_ID ?? '').trim();
  const gatewayId = (env.AI_GATEWAY_ID ?? '').trim();
  if (!accountId || !(env.AI_GATEWAY_API_TOKEN ?? '').trim() || !gatewayId) {
    throw new Error(
      'gateway runner requires AI_GATEWAY_ACCOUNT_ID, AI_GATEWAY_ID, and the AI_GATEWAY_API_TOKEN secret',
    );
  }
  const normalizedModel = normalizeRunnerModel(model ?? (await resolveRunnerModel()));
  return {
    mode: 'gateway',
    baseURL: `${env.PUBLIC_BASE_URL}/ai-proxy/v1`,
    vars: {
      TURBODIFF_AI_GATEWAY_GRANT: await createAiGatewayGrant(
        env.AI_GATEWAY_API_TOKEN,
        normalizedModel,
        Date.now() + AI_GATEWAY_GRANT_TTL_MS,
      ),
    },
    model: normalizedModel,
  };
}

// Stored runner ids now use provider/model. Keep accepting the old bare
// Anthropic ids so in-flight Workflow state and pre-migration rows can finish.
export function normalizeRunnerModel(model: string): string {
  let selected = model.trim();
  if (!selected) throw new Error('runner model is required');
  if (selected.startsWith('cloudflare-ai-gateway/')) {
    selected = selected.slice('cloudflare-ai-gateway/'.length);
  }
  if (selected.startsWith('cloudflare/')) selected = selected.slice('cloudflare/'.length);
  if (selected.startsWith('workers-ai/@cf/')) selected = selected.slice('workers-ai/'.length);
  if (!selected.includes('/')) selected = `anthropic/${selected}`;
  if (selected === 'anthropic/claude-fable-5-1') return 'anthropic/claude-fable-5.1';
  if (selected === 'anthropic/claude-haiku-4-5-20251001') return 'anthropic/claude-haiku-4.5';
  return selected;
}
