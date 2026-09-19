import { env } from 'cloudflare:workers';
import type { Context } from 'hono';
import { trackAiGatewayUsage } from '../application/ai-gateway-usage.ts';
import { proxyAiGatewayRequest } from '../integrations/ai-gateway/proxy.ts';

export function handleAiGatewayProxy(context: Context): Promise<Response> {
  return proxyAiGatewayRequest(context.req.raw, {
    accountId: env.AI_GATEWAY_ACCOUNT_ID,
    gatewayId: env.AI_GATEWAY_ID,
    apiToken: env.AI_GATEWAY_API_TOKEN,
    recordLog: (reference) => {
      context.executionCtx.waitUntil(trackAiGatewayUsage(reference));
    },
  });
}
