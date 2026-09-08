import { isJsonObject, isNumber, isString, parseJson, type JsonObject } from '../../shared/json.ts';
import type { CliUsage } from '../../shared/usage.ts';

function jsonLines(stdout: string): JsonObject[] {
  const parsed: JsonObject[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const value = parseJson(line);
      if (isJsonObject(value)) parsed.push(value);
    } catch {
      // A killed process can leave a truncated final line. Earlier complete
      // events still carry useful output, session, and metering information.
    }
  }
  return parsed;
}

export function codingAgentResultText(stdout: string): string {
  const texts: string[] = [];
  for (const event of jsonLines(stdout)) {
    if (event.type !== 'text' || !isJsonObject(event.part)) continue;
    if (isString(event.part.text)) texts.push(event.part.text);
  }
  return texts.at(-1) ?? stdout;
}

export function codingAgentSessionId(stdout: string): string | null {
  for (const event of jsonLines(stdout)) {
    const id = event.sessionID;
    if (isString(id) && /^ses_[A-Za-z0-9_-]{8,128}$/.test(id)) return id;
  }
  return null;
}

export function parseCodingAgentUsage(
  stdout: string,
  model: string | null = null,
): CliUsage | null {
  let seen = false;
  const total: CliUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    model,
  };
  for (const event of jsonLines(stdout)) {
    if (event.type !== 'step_finish' || !isJsonObject(event.part)) continue;
    const part = event.part;
    if (!isJsonObject(part.tokens)) continue;
    seen = true;
    total.inputTokens += isNumber(part.tokens.input) ? part.tokens.input : 0;
    total.outputTokens += isNumber(part.tokens.output) ? part.tokens.output : 0;
    if (isJsonObject(part.tokens.cache)) {
      total.cacheReadTokens += isNumber(part.tokens.cache.read) ? part.tokens.cache.read : 0;
      total.cacheWriteTokens += isNumber(part.tokens.cache.write) ? part.tokens.cache.write : 0;
    }
    total.costUsd += isNumber(part.cost) ? part.cost : 0;
  }
  return seen ? total : null;
}

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
