import { env } from 'cloudflare:workers';
import {
  deferAiGatewayUsage,
  listPendingAiGatewayUsage,
  recordAiGatewayUsage,
  registerAiGatewayUsage,
  type PendingAiGatewayUsageRow,
} from '../data/ai-gateway-usage.ts';
import { getAiGatewayLogUsage } from '../integrations/ai-gateway/logs.ts';

const RETRY_LIMIT_MINUTES = 24 * 60;

function retryAt(attempts: number): string {
  const minutes = Math.min(RETRY_LIMIT_MINUTES, 2 ** Math.min(attempts, 11));
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

export async function trackAiGatewayUsage(reference: {
  logId: string;
  organizationId: string;
  agentRunId: number;
}): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await registerAiGatewayUsage(reference);
      await reconcileAiGatewayUsage({
        log_id: reference.logId,
        organization_id: reference.organizationId,
        agent_run_id: reference.agentRunId,
        attempts: 0,
      });
      return;
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : 'usage registration failed';
      if (attempt === 2) {
        console.error(
          JSON.stringify({
            message: 'turbodiff: AI Gateway usage registration failed',
            logId: reference.logId,
            agentRunId: reference.agentRunId,
            reason: message,
          }),
        );
        return;
      }
      await scheduler.wait(250 * 4 ** attempt);
    }
  }
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
