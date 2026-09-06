import { describe, expect, it } from 'vite-plus/test';
import {
  canResumeLifecycleRun,
  REVIEW_REPAIR_EXHAUSTED,
  VERIFY_REPAIR_EXHAUSTED,
} from './lifecycle-resume.ts';

describe('lifecycle resume eligibility shared by the service and UI', () => {
  it.each([
    ['review', REVIEW_REPAIR_EXHAUSTED],
    ['verify', VERIFY_REPAIR_EXHAUSTED],
  ])('allows a completed %s check paused by the repair budget', (stage, reason) => {
    expect(
      canResumeLifecycleRun(
        { status: 'awaiting_human', handoff_reason: reason },
        { stage, status: 'completed' },
      ),
    ).toBe(true);
  });

  it('retains retries for stage failures', () => {
    expect(
      canResumeLifecycleRun(
        {
          status: 'awaiting_human',
          handoff_reason: 'stage failure requires retry policy evaluation',
        },
        { stage: 'repair', status: 'failed' },
      ),
    ).toBe(true);
  });

  it.each(['active', 'handed_off', 'completed', 'cancelled', 'failed'])(
    'does not resume a %s run',
    (status) => {
      expect(
        canResumeLifecycleRun(
          { status, handoff_reason: REVIEW_REPAIR_EXHAUSTED },
          { stage: 'review', status: 'completed' },
        ),
      ).toBe(false);
    },
  );

  it('does not bypass a different human decision or resume a queued stage', () => {
    expect(
      canResumeLifecycleRun(
        {
          status: 'awaiting_human',
          handoff_reason: 'acceptance criteria conflict requires a human decision',
        },
        { stage: 'verify', status: 'completed' },
      ),
    ).toBe(false);
    expect(
      canResumeLifecycleRun(
        { status: 'awaiting_human', handoff_reason: REVIEW_REPAIR_EXHAUSTED },
        { stage: 'review', status: 'queued' },
      ),
    ).toBe(false);
  });
});
