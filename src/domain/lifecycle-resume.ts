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

// The stage a resume schedules. A failed repair is not retried as a repair:
// the fixer already found nothing to do or the budget is spent, and what
// the human did in the meantime (a manual fix, a config change, an
// infrastructure fix) is proven by re-running the check the repair was
// scheduled for — the last completed review or verify before it. Live
// finding: a run parked on its third, empty repair offered only "Retry
// repair", which could only fail on the exhausted budget.
export function resumeTargetStage<S extends ResumableStage>(stages: readonly S[]): S | undefined {
  const latest = stages.at(-1);
  if (!latest || latest.stage !== 'repair' || latest.status !== 'failed') return latest;
  for (let i = stages.length - 2; i >= 0; i--) {
    const stage = stages[i];
    if ((stage.stage === 'review' || stage.stage === 'verify') && stage.status === 'completed') {
      return stage;
    }
  }
  return latest;
}
