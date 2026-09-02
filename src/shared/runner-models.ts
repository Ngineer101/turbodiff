// The models a task's sandboxed Claude Code runs may use. The authoritative
// list now lives in the app.models catalog table (see src/data/models.ts);
// these constants are the fallback when the table is empty (server) and the
// not-yet-loaded picker state (client). The id lands in the runner env as
// ANTHROPIC_MODEL.

export const DEFAULT_RUNNER_MODEL = 'claude-fable-5';

export const RUNNER_MODELS = [
  { id: 'claude-fable-5', label: 'Fable 5' },
  { id: 'claude-opus-5', label: 'Opus 5' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
] as const;
