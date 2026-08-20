// Parses the result payload of a headless `claude -p` run (confirmed
// empirically against the installed CLI — the result message carries a
// top-level `total_cost_usd` and `usage` object in snake_case, plus a
// `modelUsage` map keyed by model id). Two stdout shapes reach here:
// `--output-format json` prints that object alone; `--output-format
// stream-json` prints one JSON object per line (the full transcript) with
// the same payload as its final `type: "result"` line.

import { isJsonObject, isString, parseJson, type JsonObject } from '../../shared/json.ts';
import type { CliUsage } from '../../shared/usage.ts';

export type { CliUsage } from '../../shared/usage.ts';

function tryParseObject(text: string): JsonObject | null {
  try {
    const parsed = parseJson(text);
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseCliResult(stdout: string): JsonObject | null {
  const whole = tryParseObject(stdout.trim());
  if (whole) return whole;
  // stream-json: scan lines from the end for the result message — a killed
  // run may leave a truncated final line, and earlier lines aren't results.
  const lines = stdout.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const parsed = tryParseObject((lines[i] ?? '').trim());
    if (parsed && parsed.type === 'result') return parsed;
  }
  return null;
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

// The session id from the same payload. A later `claude -p --resume <id>`
// continues that session with its full context — the repair loop uses this to
// hand check failures back to the agent that made the changes.
export function claudeCliSessionId(stdout: string): string | null {
  const id = parseCliResult(stdout)?.session_id;
  // Resumed ids travel into a shell command line (via env, but belt and
  // braces): accept only the CLI's uuid shape.
  return isString(id) && /^[0-9a-f-]{16,64}$/i.test(id) ? id : null;
}

// Fold one run's usage into a running total — repair rounds bill the same
// feature or fix attempt as the run they repair. Model: first seen wins (all
// rounds run the same model).
export function addCliUsage(total: CliUsage | null, next: CliUsage | null): CliUsage | null {
  if (!total) return next;
  if (!next) return total;
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    cacheReadTokens: total.cacheReadTokens + next.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens + next.cacheWriteTokens,
    costUsd: total.costUsd + next.costUsd,
    model: total.model ?? next.model,
  };
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
