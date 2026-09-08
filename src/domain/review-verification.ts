export interface CandidateFinding {
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  startLine?: number;
  severity: 'P1' | 'P2';
  body: string;
  evidence: string;
  failurePath: string;
}

export interface FindingDecision {
  candidate: number;
  accepted: boolean;
  confidence: 'low' | 'medium' | 'high';
  severity: 'P1' | 'P2';
  reason: string;
}

function fingerprint(finding: CandidateFinding): string {
  return [
    finding.path.toLowerCase(),
    finding.side,
    finding.line,
    finding.body.toLowerCase().replaceAll(/\s+/g, ' ').trim(),
  ].join(':');
}

export function consolidateCandidates(findings: CandidateFinding[]): CandidateFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = fingerprint(finding);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function decisionsCoverCandidates(
  candidateCount: number,
  decisions: FindingDecision[],
): boolean {
  if (decisions.length !== candidateCount) return false;
  const indexes = new Set(decisions.map((decision) => decision.candidate));
  return indexes.size === candidateCount && [...indexes].every((index) => index < candidateCount);
}

function withSeverity(body: string, severity: 'P1' | 'P2'): string {
  const tag = severity === 'P1' ? '🔴 **P1**' : '🟡 **P2**';
  const replaced = body.replace(/^(?:🔴|🟡)?\s*\*\*P[12]\*\*/u, tag);
  return replaced === body ? `${tag} ${body}` : replaced;
}

// A verifier can reject or downgrade a candidate, never promote one. Only a
// high-confidence acceptance is publishable; missing, duplicated, malformed,
// or uncertain decisions fail closed.
export function applyFindingDecisions(
  candidates: CandidateFinding[],
  decisions: FindingDecision[],
): CandidateFinding[] {
  const decided = new Set<number>();
  const output: CandidateFinding[] = [];
  for (const decision of decisions) {
    if (decided.has(decision.candidate)) continue;
    decided.add(decision.candidate);
    const candidate = candidates[decision.candidate];
    if (!candidate || !decision.accepted || decision.confidence !== 'high') continue;
    const severity = candidate.severity === 'P1' && decision.severity === 'P1' ? 'P1' : 'P2';
    output.push({ ...candidate, severity, body: withSeverity(candidate.body, severity) });
  }
  return output;
}
