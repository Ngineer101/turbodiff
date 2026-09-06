export const REVIEW_REPAIR_EXHAUSTED = 'blocking findings remain and repair policy is exhausted';
export const VERIFY_REPAIR_EXHAUSTED = 'verification failed and repair policy is exhausted';

interface ResumableRun {
  status: string;
  handoff_reason: string | null;
}

interface ResumableStage {
  stage: string;
  status: string;
}

// A completed check can pause on its verdict. Resume reruns that check after
// human intervention; it never resets or bypasses the automatic repair cap.
export function isRepairBudgetPause(
  run: ResumableRun,
  latest: ResumableStage | undefined,
): boolean {
  return (
    run.status === 'awaiting_human' &&
    latest?.status === 'completed' &&
    ((latest.stage === 'review' && run.handoff_reason === REVIEW_REPAIR_EXHAUSTED) ||
      (latest.stage === 'verify' && run.handoff_reason === VERIFY_REPAIR_EXHAUSTED))
  );
}

export function canResumeLifecycleRun(
  run: ResumableRun,
  latest: ResumableStage | undefined,
): boolean {
  return (
    run.status === 'awaiting_human' &&
    (latest?.status === 'failed' || isRepairBudgetPause(run, latest))
  );
}
