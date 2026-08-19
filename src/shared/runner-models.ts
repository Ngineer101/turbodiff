// The models a task's sandboxed Claude Code runs may use. Shared between the
// board/task UI (the picker) and the API (validation) — the id lands in the
// runner env as ANTHROPIC_MODEL, so only ids from this list are accepted.

export const DEFAULT_RUNNER_MODEL = 'claude-fable-5';

export const RUNNER_MODELS = [
  { id: 'claude-fable-5', label: 'Fable 5' },
  { id: 'claude-opus-5', label: 'Opus 5' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
] as const;

export function isRunnerModel(value: string): boolean {
  return RUNNER_MODELS.some((m) => m.id === value);
}
