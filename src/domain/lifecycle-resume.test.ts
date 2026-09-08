import { describe, expect, it } from 'vite-plus/test';
import {
  canResumeLifecycleRun,
  resumeTargetStage,
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

describe('resumeTargetStage', () => {
  const done = (stage: string) => ({ stage, status: 'completed' });

  it('resumes a failed repair as the check it was repairing for', () => {
    const stages = [
      done('implement'),
      done('review'),
      done('verify'),
      { stage: 'repair', status: 'failed' },
    ];
    expect(resumeTargetStage(stages)).toBe(stages[2]);
    const afterReview = [
      done('review'),
      done('repair'),
      done('review'),
      { stage: 'repair', status: 'failed' },
    ];
    expect(resumeTargetStage(afterReview)).toBe(afterReview[2]);
  });

  it('retries any other failed stage as itself', () => {
    const stages = [done('implement'), { stage: 'review', status: 'failed' }];
    expect(resumeTargetStage(stages)).toBe(stages[1]);
    const verify = [done('review'), { stage: 'verify', status: 'failed' }];
    expect(resumeTargetStage(verify)).toBe(verify[1]);
  });

  it('falls back to the repair itself when no check precedes it, and to nothing on an empty run', () => {
    const stages = [{ stage: 'repair', status: 'failed' }];
    expect(resumeTargetStage(stages)).toBe(stages[0]);
    expect(resumeTargetStage([])).toBeUndefined();
  });
});
