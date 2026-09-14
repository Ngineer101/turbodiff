import { sql } from 'drizzle-orm';
import { queryOne, queryRows, sqlValueList } from './database.ts';

export interface UsageTotalsRow {
  agent_runs: number;
  running: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
}

export interface UsageBreakdownRow {
  key: string;
  runs: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

const EMPTY_TOTALS: UsageTotalsRow = {
  agent_runs: 0,
  running: 0,
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  cost_usd: 0,
};

export async function usageSummary(
  organizationIds: string[],
  month: string,
): Promise<{
  totals: UsageTotalsRow;
  byAgent: UsageBreakdownRow[];
  byModel: UsageBreakdownRow[];
  byFlow: UsageBreakdownRow[];
}> {
  if (organizationIds.length === 0) {
    return { totals: EMPTY_TOTALS, byAgent: [], byModel: [], byFlow: [] };
  }
  const monthStart = `${month}-01T00:00:00.000Z`;
  const common = sql`
    FROM app.agent_runs ar
    JOIN app.stage_runs sr ON sr.id = ar.stage_run_id
    JOIN app.factory_runs fr ON fr.id = sr.factory_run_id
    JOIN app.agents a ON a.id = ar.agent_id
    JOIN app.models m ON m.id = ar.model_id
    WHERE ar.organization_id IN (${sqlValueList(organizationIds)})
      AND ar.created_at >= ${monthStart}::timestamptz
      AND ar.created_at < (${monthStart}::timestamptz + INTERVAL '1 month')
  `;
  const totals = await queryOne<UsageTotalsRow>(sql`
    SELECT COUNT(*) AS agent_runs,
      COUNT(*) FILTER (WHERE ar.status IN ('queued', 'running')) AS running,
      COALESCE(SUM(ar.input_tokens), 0) AS input_tokens,
      COALESCE(SUM(ar.output_tokens), 0) AS output_tokens,
      COALESCE(SUM(ar.cache_read_tokens), 0) AS cache_read_tokens,
      COALESCE(SUM(ar.cache_write_tokens), 0) AS cache_write_tokens,
      COALESCE(SUM(ar.cost_usd), 0) AS cost_usd
    ${common}
  `);
  const breakdown = (key: 'a.slug' | "m.provider || '/' || m.model_id" | 'fr.flow_key') =>
    queryRows<UsageBreakdownRow>(sql`
      SELECT ${sql.raw(key)} AS key, COUNT(*) AS runs,
        COALESCE(SUM(ar.input_tokens), 0) AS input_tokens,
        COALESCE(SUM(ar.output_tokens), 0) AS output_tokens,
        COALESCE(SUM(ar.cost_usd), 0) AS cost_usd
      ${common}
      GROUP BY 1 ORDER BY cost_usd DESC, key
    `);
  const [byAgent, byModel, byFlow] = await Promise.all([
    breakdown('a.slug'),
    breakdown("m.provider || '/' || m.model_id"),
    breakdown('fr.flow_key'),
  ]);
  return { totals: totals ?? EMPTY_TOTALS, byAgent, byModel, byFlow };
}
