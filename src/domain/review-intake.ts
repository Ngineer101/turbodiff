import type { ChangeOrigin } from './lifecycle-contract.ts';

export const REVIEW_INTAKE_MODES = ['factory_only', 'on_demand', 'all_changes'] as const;
export type ReviewIntakeMode = (typeof REVIEW_INTAKE_MODES)[number];
export type ReviewIntakeEvent = 'opened' | 'updated' | 'manual';

export type ReviewIntakeDecision = { kind: 'admit' } | { kind: 'ignore'; reason: string };

export function decideReviewIntake(input: {
  mode: ReviewIntakeMode;
  origin: ChangeOrigin;
  event: ReviewIntakeEvent;
  draft: boolean;
}): ReviewIntakeDecision {
  if (input.draft) return { kind: 'ignore', reason: 'change is draft' };

  if (input.event === 'manual') {
    if (input.mode === 'factory_only' && input.origin !== 'factory') {
      return { kind: 'ignore', reason: 'repository admits factory changes only' };
    }
    return { kind: 'admit' };
  }

  if (input.mode === 'on_demand') {
    return { kind: 'ignore', reason: 'review requires an explicit request' };
  }
  if (input.mode === 'factory_only' && input.origin !== 'factory') {
    return { kind: 'ignore', reason: 'repository admits factory changes only' };
  }
  return { kind: 'admit' };
}
