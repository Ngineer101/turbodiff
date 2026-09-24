import { env } from 'cloudflare:workers';
import {
  deferAiGatewayUsage,
  listPendingAiGatewayUsage,
  recordAiGatewayUsage,
  registerAiGatewayUsage,
  type PendingAiGatewayUsageRow,
} from '../data/ai-gateway-usage.ts';
import { getAiGatewayLogUsage } from '../integrations/ai-gateway/logs.ts';
import { aiGatewayUsageQueueMessage, type AiGatewayUsageReference } from './queue-message.ts';

const RETRY_LIMIT_MINUTES = 24 * 60;

function retryAt(attempts: number): string {
  const minutes = Math.min(RETRY_LIMIT_MINUTES, 2 ** Math.min(attempts, 11));
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

export async function enqueueAiGatewayUsage(reference: AiGatewayUsageReference): Promise<void> {
  await env.FACTORY_QUEUE.send(aiGatewayUsageQueueMessage(reference), { contentType: 'json' });
}

export async function trackAiGatewayUsage(reference: AiGatewayUsageReference): Promise<void> {
  // Registration runs from Cloudflare Queues, so a transient database failure
  // rejects the delivery and is durably retried instead of losing the log id.
  await registerAiGatewayUsage(reference);
  await reconcileAiGatewayUsage({
    log_id: reference.logId,
    organization_id: reference.organizationId,
    agent_run_id: reference.agentRunId,
    attempts: 0,
  });
}

export async function reconcileAiGatewayUsage(pending: PendingAiGatewayUsageRow): Promise<void> {
  try {
    const usage = await getAiGatewayLogUsage(
      {
        accountId: env.AI_GATEWAY_ACCOUNT_ID,
        gatewayId: env.AI_GATEWAY_ID,
        apiToken: env.AI_GATEWAY_API_TOKEN,
      },
      {
        logId: pending.log_id,
        organizationId: pending.organization_id,
        agentRunId: pending.agent_run_id,
      },
    );
    if (!usage) throw new Error('AI Gateway log cost is not available yet');
    await recordAiGatewayUsage(usage);
  } catch (failure) {
    const message = failure instanceof Error ? failure.message : 'AI Gateway reconciliation failed';
    await deferAiGatewayUsage({
      logId: pending.log_id,
      message,
      nextAttemptAt: retryAt(pending.attempts),
    });
    console.warn(
      JSON.stringify({
        message: 'turbodiff: AI Gateway usage reconciliation deferred',
        logId: pending.log_id,
        agentRunId: pending.agent_run_id,
        reason: message,
      }),
    );
  }
}

export async function reconcilePendingAiGatewayUsage(limit = 50): Promise<void> {
  for (const pending of await listPendingAiGatewayUsage(limit)) {
    await reconcileAiGatewayUsage(pending);
  }
}
