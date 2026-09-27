import { sql } from 'drizzle-orm';
import { execute, queryRows, withTransaction } from './postgres.ts';

export interface PendingAiGatewayUsageRow {
  log_id: string;
  organization_id: string;
  agent_run_id: number;
  attempts: number;
}

export async function registerAiGatewayUsage(input: {
  logId: string;
  organizationId: string;
  agentRunId: number;
}): Promise<void> {
  await execute(sql`
    INSERT INTO app.ai_gateway_usage (log_id, organization_id, agent_run_id)
    VALUES (${input.logId}, ${input.organizationId}, ${input.agentRunId})
    ON CONFLICT (log_id) DO NOTHING
  `);
}

export function listPendingAiGatewayUsage(limit = 50): Promise<PendingAiGatewayUsageRow[]> {
  return queryRows<PendingAiGatewayUsageRow>(sql`
    SELECT log_id, organization_id, agent_run_id, attempts
    FROM app.ai_gateway_usage
    WHERE reconciled_at IS NULL AND next_attempt_at <= CURRENT_TIMESTAMP
    ORDER BY next_attempt_at, created_at
    LIMIT ${limit}
  `);
}

export async function recordAiGatewayUsage(input: {
  logId: string;
  organizationId: string;
  agentRunId: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}): Promise<void> {
  await withTransaction(async () => {
    // Serialize every cost rollup for one run before changing a usage row.
    // Under READ COMMITTED this ensures the later aggregate sees any usage
    // committed by the previous lock holder rather than overwriting it with a
    // partial statement snapshot.
    await execute(sql`
      SELECT id FROM app.agent_runs
      WHERE id = ${input.agentRunId} AND organization_id = ${input.organizationId}
      FOR UPDATE
    `);
    await execute(sql`
      UPDATE app.ai_gateway_usage SET tokens_in = ${input.tokensIn},
        tokens_out = ${input.tokensOut}, cost_usd = ${input.costUsd},
        reconciled_at = CURRENT_TIMESTAMP, last_error = NULL
      WHERE log_id = ${input.logId} AND organization_id = ${input.organizationId}
        AND agent_run_id = ${input.agentRunId} AND reconciled_at IS NULL
    `);
    await execute(sql`
      UPDATE app.agent_runs ar SET cost_usd = usage.cost_usd
      FROM (
        SELECT agent_run_id, organization_id, COALESCE(SUM(cost_usd), 0) AS cost_usd
        FROM app.ai_gateway_usage
        WHERE agent_run_id = ${input.agentRunId} AND organization_id = ${input.organizationId}
          AND reconciled_at IS NOT NULL
        GROUP BY agent_run_id, organization_id
      ) usage
      WHERE ar.id = usage.agent_run_id AND ar.organization_id = usage.organization_id
    `);
  });
}

export async function deferAiGatewayUsage(input: {
  logId: string;
  message: string;
  nextAttemptAt: string;
}): Promise<void> {
  await execute(sql`
    UPDATE app.ai_gateway_usage SET attempts = attempts + 1,
      last_error = ${input.message.slice(0, 1_000)}, next_attempt_at = ${input.nextAttemptAt}
    WHERE log_id = ${input.logId} AND reconciled_at IS NULL
  `);
}
