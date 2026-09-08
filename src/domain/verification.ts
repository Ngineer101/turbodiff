// Pure verification-domain helpers shared by the verifier runner and the
// criteria-conflict resolution route — one format for "unmet criteria as fix
// findings" so the restore-planned-behavior path dispatches exactly the fix
// the automatic path would have.

import { parseUtc, VERIFY_STALL_AFTER_MS } from '../shared/time.ts';

// Feature lifecycle states after which a new verification run is pointless:
// the PR/CR is merged or closed, so there is nothing left to prove.
const VERIFY_TERMINAL_FEATURE_STATUSES = new Set(['merged', 'abandoned', 'pr_closed']);

// The dispatch gate for startVerification: every enqueue path (fixer, chat,
// conflict resolver, criteria route, generation) funnels through it, so a
// merge landing mid-run can no longer mint a fresh 'running' row that
// supersedes an earlier verdict.
export function verificationSkipReason(
  feature: { status: string },
  latest: { status: string; created_at: string } | null,
  now: number,
): 'terminal' | 'in_flight' | null {
  if (VERIFY_TERMINAL_FEATURE_STATUSES.has(feature.status)) return 'terminal';
  if (latest?.status === 'running' && now - parseUtc(latest.created_at) < VERIFY_STALL_AFTER_MS) {
    return 'in_flight';
  }
  return null;
}

// Clock tolerance between the Workflows engine's instance timestamp and the
// database's row timestamps.
const INSTANCE_CLOCK_SKEW_MS = 60_000;

// A Workflows step callback can execute more than once: the engine re-runs
// it when an attempt ends in an internal error, even after the callback's
// own work finished (live finding: verify-6's first attempt recorded a full
// failed verdict and dispatched the fix, then died with "Attempt failed due
// to internal workflows error" and was re-executed at once — a second
// verification of a checkout that predated the fix already in flight). A
// terminal verdict recorded since this instance was queued is this
// instance's verdict, so the re-run has nothing to add. A 'running' or
// 'error' row is a dead earlier attempt: re-running is the intended
// recovery (the fresh row supersedes it).
export function verdictRecordedSince(
  latest: { status: string; created_at: string } | null,
  instanceQueuedAt: number,
): boolean {
  if (!latest || (latest.status !== 'passed' && latest.status !== 'failed')) return false;
  return parseUtc(latest.created_at) >= instanceQueuedAt - INSTANCE_CLOCK_SKEW_MS;
}

// The lifecycle outcome of a verify stage, from the verification it ran.
// Only a verdict completes the stage; an 'error' (sandbox, git, agent crash)
// or a missing row fails it, so the coordinator parks the run for a retry of
// verify instead of spending a repair on a verdict that was never reached.
// Live finding: a cache-sync error read as "verification failed" scheduled
// the last repair in the budget, which found nothing to fix, and the run
// parked on a failed repair with no way back to verify.
export interface VerifyStageOutcome {
  success: boolean;
  facts: { verificationPassed?: boolean };
}
export function verifyStageOutcome(status: string | null | undefined): VerifyStageOutcome {
  if (status === 'passed' || status === 'failed') {
    return { success: true, facts: { verificationPassed: status === 'passed' } };
  }
  return { success: false, facts: {} };
}

export interface CriterionResult {
  index: number;
  verdict: 'pass' | 'fail' | 'skip';
  note: string;
  screenshot?: string;
}

// Every criterion a verification graded, in result order: the feature's
// stored acceptance criteria (verdict null when the run recorded nothing for
// them) followed by any row the results carry beyond them. Verifications
// recorded before 2026-09-08 carry one such row from a since-removed
// adversarial "premortem" pass (8 of 8 runs failed it, no feature ever
// cleared it); readers must still show it rather than paint N/N proven
// under a failed verdict.
export function gradedCriteria(
  acceptance: string[],
  results: CriterionResult[],
): { text: string; result: CriterionResult | null }[] {
  const rows = acceptance.map((text, i) => ({
    text,
    result: results.find((r) => r.index === i) ?? null,
  }));
  const appended = results
    .filter((r) => r.index >= acceptance.length)
    .sort((a, b) => a.index - b.index);
  for (const result of appended) {
    rows.push({ text: `Verification check #${result.index + 1} (retired)`, result });
  }
  return rows;
}

export function formatUnmetCriteriaFindings(
  criteria: string[],
  results: CriterionResult[],
): string {
  return gradedCriteria(criteria, results)
    .filter((row) => row.result?.verdict === 'fail')
    .map(
      (row) =>
        `**P1** — Acceptance criterion not met: ${row.text}\n\nEvidence: ${row.result?.note ?? ''}`,
    )
    .join('\n\n');
}
