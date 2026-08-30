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

export interface CriterionResult {
  index: number;
  verdict: 'pass' | 'fail' | 'skip';
  note: string;
  screenshot?: string;
}

export function formatUnmetCriteriaFindings(
  criteria: string[],
  results: CriterionResult[],
): string {
  return results
    .filter((r) => r.verdict === 'fail')
    .map(
      (f) => `**P1** — Acceptance criterion not met: ${criteria[f.index]}\n\nEvidence: ${f.note}`,
    )
    .join('\n\n');
}
