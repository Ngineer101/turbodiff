// Pure verification-domain helpers shared by the verifier runner and the
// criteria-conflict resolution route — one format for "unmet criteria as fix
// findings" so the restore-planned-behavior path dispatches exactly the fix
// the automatic path would have.

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
