import { sql } from 'drizzle-orm';
import { STALL_AFTER_MINUTES } from '../shared/time.ts';
import type { ExplanationDocument } from '../shared/api-types.ts';
import type { JsonValue } from '../shared/json.ts';
import { execute, queryOne, queryRows, withTransaction } from './database.ts';
import { minutesAgo } from './sql.ts';

// Explain-tab documents (src/domain/explain.ts). Rows are written by the
// explain dispatcher (running), the Explainer agent's submit tool (ready),
// and the settlement observer (failed); the cockpit reads the latest row
// for the head it is showing.

export interface ExplanationRow {
  id: number;
  feature_id: number;
  head_sha: string;
  status: string; // running | ready | failed
  agent_instance_id: string;
  document: JsonValue | null;
  model: string | null;
  error: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  created_at: string;
  completed_at: string | null;
}

// Admits one running explanation per feature. A stalled earlier run (no
// completion inside the stall window) is failed first so it can't block
// regeneration forever; a live one makes this return null (in flight).
export async function tryRecordExplanation(
  featureId: number,
  headSha: string,
  agentInstanceId: string,
  model: string,
): Promise<number | null> {
  return withTransaction(async (transaction) => {
    await transaction.execute(sql`
      UPDATE app.feature_explanations SET status = 'failed', completed_at = CURRENT_TIMESTAMP,
        error = COALESCE(error, 'stalled: no completion before a replacement was admitted')
      WHERE feature_id = ${featureId} AND status = 'running'
        AND created_at < ${minutesAgo(STALL_AFTER_MINUTES)}
    `);
    const result = await transaction.execute<{ id: number }>(sql`
      INSERT INTO app.feature_explanations (feature_id, head_sha, status, agent_instance_id, model)
      VALUES (${featureId}, ${headSha}, 'running', ${agentInstanceId}, ${model})
      ON CONFLICT DO NOTHING
      RETURNING id
    `);
    return result.rows[0]?.id ?? null;
  });
}

export async function latestExplanation(
  featureId: number,
  headSha: string,
): Promise<ExplanationRow | null> {
  return queryOne<ExplanationRow>(sql`
    SELECT * FROM app.feature_explanations
    WHERE feature_id = ${featureId} AND head_sha = ${headSha}
    ORDER BY id DESC LIMIT 1
  `);
}

// The newest finished document for any head — what the cockpit shows (marked
// stale) while the current head's explanation is still being written.
export async function latestReadyExplanation(featureId: number): Promise<ExplanationRow | null> {
  return queryOne<ExplanationRow>(sql`
    SELECT * FROM app.feature_explanations
    WHERE feature_id = ${featureId} AND status = 'ready'
    ORDER BY id DESC LIMIT 1
  `);
}

export async function getExplanationByInstance(
  agentInstanceId: string,
): Promise<ExplanationRow | null> {
  return queryOne<ExplanationRow>(sql`
    SELECT * FROM app.feature_explanations WHERE agent_instance_id = ${agentInstanceId}
  `);
}

// Called by submit_explanation. Keyed by the exact instance so a regenerate
// can never complete the row of the run it replaced.
export async function completeExplanation(
  agentInstanceId: string,
  document: ExplanationDocument,
): Promise<ExplanationRow | null> {
  return queryOne<ExplanationRow>(sql`
    UPDATE app.feature_explanations
    SET status = 'ready', completed_at = CURRENT_TIMESTAMP, error = NULL,
      document = ${JSON.stringify(document)}::jsonb
    WHERE agent_instance_id = ${agentInstanceId} AND status = 'running'
    RETURNING *
  `);
}

export async function failExplanation(
  agentInstanceId: string,
  reason: string | null,
): Promise<ExplanationRow | null> {
  return queryOne<ExplanationRow>(sql`
    UPDATE app.feature_explanations
    SET status = 'failed', completed_at = CURRENT_TIMESTAMP, error = ${reason}
    WHERE agent_instance_id = ${agentInstanceId} AND status = 'running'
    RETURNING *
  `);
}

export async function addExplanationUsage(
  agentInstanceId: string,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
    model: string;
  },
): Promise<void> {
  await execute(sql`
    UPDATE app.feature_explanations SET
      input_tokens = input_tokens + ${usage.inputTokens},
      output_tokens = output_tokens + ${usage.outputTokens},
      cache_read_tokens = cache_read_tokens + ${usage.cacheReadTokens},
      cache_write_tokens = cache_write_tokens + ${usage.cacheWriteTokens},
      cost_usd = cost_usd + ${usage.costUsd}, model = ${usage.model}
    WHERE agent_instance_id = ${agentInstanceId}
  `);
}

export async function listExplanationsForFeature(featureId: number): Promise<ExplanationRow[]> {
  return queryRows<ExplanationRow>(sql`
    SELECT * FROM app.feature_explanations WHERE feature_id = ${featureId} ORDER BY id DESC
  `);
}
