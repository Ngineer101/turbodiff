import type { PlanningTier } from '../artifacts/plan.ts';

// Whether a task needs the thorough planning path or a small, proportionate one
// is a semantic judgment, not a rule code can compute from length alone. We hand
// a few cheap-to-gather signals to a System One model (Jev) and let it pick the
// tier; this module owns the pure policy — what context the model sees and how
// its answer maps to a tier — while the provider call lives in `integrations`.

/**
 * Signals available before any repository checkout. Kept deliberately small so
 * the judgment is one fast model call rather than a research pass over the code.
 */
export interface TaskComplexitySignals {
  title: string;
  requirements: string;
  repositoryCount: number;
  attachmentCount: number;
}

/**
 * Only take the trivial (cheaper, terser) planning path when the model is
 * clearly confident the task is small. Below this, fall back to `standard` so
 * borderline or uncertain work still gets the full investigation and questions.
 */
export const TRIVIAL_CONFIDENCE_FLOOR = 0.6;

/** The context handed to the model as the judgment's state. */
export function taskComplexityState(signals: TaskComplexitySignals) {
  return {
    title: signals.title,
    requirements: signals.requirements,
    repositoryCount: signals.repositoryCount,
    attachmentCount: signals.attachmentCount,
  };
}

/** The relevant fields of a Choice answer, decoupled from the SDK's types. */
export interface ComplexityChoice {
  choice: string;
  confidence: number;
}

/**
 * Map the model's choice to a planning tier. `standard` is the safe default: the
 * trivial path is taken only on a confident `trivial` selection, so an
 * unexpected label or a low-confidence guess errs toward thorough planning.
 */
export function tierFromComplexityChoice(answer: ComplexityChoice): PlanningTier {
  return answer.choice === 'trivial' && answer.confidence >= TRIVIAL_CONFIDENCE_FLOOR
    ? 'trivial'
    : 'standard';
}
