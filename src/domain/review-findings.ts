// Severity reconciliation for review findings. Lives in the domain layer so
// the GitHub review tool and the native change-request engine share one
// definition of what blocks a merge.

// The fields a severity decision reads; both tool surfaces pass their full
// validated finding objects.
export interface ReviewFinding {
  path: string;
  line: number;
  severity: 'P1' | 'P2';
  body: string;
}

// Severity gates merges in blocking mode, so the model's structured field is
// not trusted alone: the body's literal **P1** tag is an independent claim of
// the same fact. A finding counts as P1 when either says so — a mislabel can
// then only escalate (a spurious REQUEST_CHANGES a re-review clears), never
// silently APPROVE past a real P1 — and disagreements are logged. The 🔴/🟡
// emoji is NOT a severity claim: agents decorate P2 nits with 🔴 despite the
// prompt's convention, and a promoted nit becomes a standing block that
// re-arms the review↔repair loop on every round.
export function findingSeverity(f: ReviewFinding): 'P1' | 'P2' {
  const bodyTagged = f.body.includes('**P1**');
  if (bodyTagged !== (f.severity === 'P1')) {
    console.warn(
      `turbodiff: severity mismatch on finding ${f.path}:${f.line} — field says ${f.severity}, ` +
        `body ${bodyTagged ? 'is' : 'is not'} tagged P1; treating as P1`,
    );
  }
  return bodyTagged || f.severity === 'P1' ? 'P1' : 'P2';
}
