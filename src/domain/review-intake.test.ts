import { describe, expect, it } from 'vite-plus/test';
import { decideReviewIntake, REVIEW_INTAKE_MODES } from './review-intake.ts';

describe('review intake policy', () => {
  it('CMP-001/CMP-002: keeps existing repositories factory-only by default', () => {
    expect(
      decideReviewIntake({
        mode: 'factory_only',
        origin: 'human',
        event: 'opened',
        draft: false,
      }),
    ).toEqual({ kind: 'ignore', reason: 'repository admits factory changes only' });
    expect(
      decideReviewIntake({
        mode: 'factory_only',
        origin: 'factory',
        event: 'opened',
        draft: false,
      }),
    ).toEqual({ kind: 'admit' });
  });

  it('REV-001/REV-002: makes on-demand intake explicit for every origin', () => {
    for (const origin of ['human', 'factory'] as const) {
      expect(
        decideReviewIntake({ mode: 'on_demand', origin, event: 'opened', draft: false }),
      ).toMatchObject({ kind: 'ignore' });
      expect(
        decideReviewIntake({ mode: 'on_demand', origin, event: 'manual', draft: false }),
      ).toEqual({ kind: 'admit' });
    }
  });

  it('REV-003/CMP-003: admits every origin in all-changes mode', () => {
    for (const origin of ['human', 'factory', 'automation', 'imported'] as const) {
      expect(
        decideReviewIntake({ mode: 'all_changes', origin, event: 'opened', draft: false }),
      ).toEqual({ kind: 'admit' });
    }
  });

  it('REV-004: never admits drafts, including explicit requests', () => {
    for (const mode of REVIEW_INTAKE_MODES) {
      expect(decideReviewIntake({ mode, origin: 'human', event: 'manual', draft: true })).toEqual({
        kind: 'ignore',
        reason: 'change is draft',
      });
    }
  });
});
