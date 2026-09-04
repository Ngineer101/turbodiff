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

// The premortem is an independent adversarial pass the verifier appends to
// the feature's acceptance criteria at run time (only when those would pass).
// Its verdict is stored with the results at index N, but the feature row
// keeps only the N human criteria — so every reader of (acceptance, results)
// must re-derive the appended row from here or silently drop the one
// criterion that failed (live finding: the cockpit showed N/N proven while
// the PR comment said 1 not met).
export const PREMORTEM_CRITERION =
  'Premortem: an independent adversarial pass found no mechanism by which the reported behavior survives this change';

// Every criterion a verification graded, in result order: the feature's
// stored acceptance criteria (verdict null when the run recorded nothing for
// them) followed by any run-time criterion the results carry beyond them.
// The first appended row is the premortem; anything further is labeled
// generically rather than mis-attributed.
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
    rows.push({
      text:
        result.index === acceptance.length
          ? PREMORTEM_CRITERION
          : `Verification check #${result.index + 1}`,
      result,
    });
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
