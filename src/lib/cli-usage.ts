// Parses the single JSON object `claude -p --output-format json` prints to
// stdout on exit (confirmed empirically against the installed CLI — the
// result message carries a top-level `total_cost_usd` and `usage` object in
// snake_case, plus a `modelUsage` map keyed by model id).

import { isJsonObject, isString, parseJson, type JsonObject } from '../shared/json.ts';

export interface CliUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  model: string | null;
}

function parseCliResult(stdout: string): JsonObject | null {
  try {
    const parsed = parseJson(stdout.trim());
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// The model's narrative text (previously carried verbatim by
// --output-format text), for the human-readable log stored in R2 and PR/notes
// copy. Falls back to the raw stdout when it isn't parseable JSON (e.g. a
// killed process that never wrote its final line) — the same content callers
// used before switching output formats.
export function claudeCliResultText(stdout: string): string {
  const result = parseCliResult(stdout)?.result;
  return isString(result) ? result : stdout;
}

// Token/cost usage from the same payload. Returns null on any parse failure
// or a payload with no usage, so callers degrade to zero-cost rather than
// failing the pipeline stage that already did real work — a metering miss
// must never fail the stage itself.
export function parseClaudeCliUsage(stdout: string): CliUsage | null {
  const parsed = parseCliResult(stdout);
  const usage = parsed?.usage;
  if (!isJsonObject(usage)) return null;
  const modelUsage = parsed?.modelUsage;
  const models = isJsonObject(modelUsage) ? Object.keys(modelUsage) : [];
  return {
    inputTokens: Number(usage.input_tokens) || 0,
    outputTokens: Number(usage.output_tokens) || 0,
    cacheReadTokens: Number(usage.cache_read_input_tokens) || 0,
    cacheWriteTokens: Number(usage.cache_creation_input_tokens) || 0,
    costUsd: Number(parsed?.total_cost_usd) || 0,
    model: models[0] ?? null,
  };
}
