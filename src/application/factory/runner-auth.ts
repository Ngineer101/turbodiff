import { env } from 'cloudflare:workers';
import { canonicalModelId, resolveModel } from '../../data/models.ts';
import type { RunnerAuth } from '../../integrations/agent-runtime/runner-config.ts';
import {
  AI_GATEWAY_GRANT_TTL_MS,
  createAiGatewayGrant,
} from '../../integrations/security/ai-gateway-grant.ts';

export async function resolveRunnerAuth(model?: string | null): Promise<RunnerAuth> {
  const accountId = (env.AI_GATEWAY_ACCOUNT_ID ?? '').trim();
  const gatewayId = (env.AI_GATEWAY_ID ?? '').trim();
  if (!accountId || !(env.AI_GATEWAY_API_TOKEN ?? '').trim() || !gatewayId) {
    throw new Error(
      'gateway runner requires AI_GATEWAY_ACCOUNT_ID, AI_GATEWAY_ID, and the AI_GATEWAY_API_TOKEN secret',
    );
  }

  const normalizedModel = canonicalModelId(await resolveModel(model));
  return {
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
