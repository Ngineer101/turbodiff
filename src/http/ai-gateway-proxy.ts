import { env } from 'cloudflare:workers';
import type { Context } from 'hono';
import { proxyAiGatewayRequest } from '../integrations/ai-gateway/proxy.ts';

export function handleAiGatewayProxy(context: Context): Promise<Response> {
  return proxyAiGatewayRequest(context.req.raw, {
    accountId: env.AI_GATEWAY_ACCOUNT_ID,
    gatewayId: env.AI_GATEWAY_ID,
    apiToken: env.AI_GATEWAY_API_TOKEN,
  });
}
