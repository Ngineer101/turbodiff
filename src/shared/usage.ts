// Provider-neutral usage totals shared by AI runners and persistence.
export interface CliUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  model: string | null;
}
