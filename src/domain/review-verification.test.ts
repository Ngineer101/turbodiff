import { describe, expect, it } from 'vite-plus/test';
import {
  applyFindingDecisions,
  consolidateCandidates,
  decisionsCoverCandidates,
  type CandidateFinding,
} from './review-verification.ts';

function candidate(overrides: Partial<CandidateFinding> = {}): CandidateFinding {
  return {
    path: 'src/app.ts',
    line: 12,
    side: 'RIGHT',
    severity: 'P1',
    body: '🔴 **P1** Request can bypass authorization.',
    evidence: 'route calls the mutation before requireUser',
    failurePath: 'anonymous request -> route -> mutation',
    ...overrides,
  };
}

describe('review finding verification', () => {
  it('collapses exact duplicate candidates before verification', () => {
    expect(consolidateCandidates([candidate(), candidate(), candidate({ line: 13 })])).toHaveLength(
      2,
    );
  });

  it('publishes only unique high-confidence acceptances', () => {
    const candidates = [candidate(), candidate({ line: 20, severity: 'P2' })];
    expect(
      applyFindingDecisions(candidates, [
        { candidate: 0, accepted: true, confidence: 'medium', severity: 'P1', reason: 'unclear' },
        { candidate: 1, accepted: true, confidence: 'high', severity: 'P2', reason: 'proved' },
        { candidate: 1, accepted: true, confidence: 'high', severity: 'P2', reason: 'duplicate' },
      ]),
    ).toEqual([{ ...candidates[1], body: '🟡 **P2** Request can bypass authorization.' }]);
  });

  it('allows downgrades but never verifier promotions', () => {
    const p1 = candidate();
    const p2 = candidate({ line: 20, severity: 'P2', body: '🟡 **P2** stale response wins' });
    const output = applyFindingDecisions(
      [p1, p2],
      [
        {
          candidate: 0,
          accepted: true,
          confidence: 'high',
          severity: 'P2',
          reason: 'limited impact',
        },
        {
          candidate: 1,
          accepted: true,
          confidence: 'high',
          severity: 'P1',
          reason: 'large impact',
        },
      ],
    );

    expect(output.map((finding) => finding.severity)).toEqual(['P2', 'P2']);
    expect(output[0].body).toMatch(/^🟡 \*\*P2\*\*/);
  });

  it('requires exactly one verifier decision per candidate', () => {
    const decision = {
      candidate: 0,
      accepted: false,
      confidence: 'high' as const,
      severity: 'P2' as const,
      reason: 'disproved',
    };
    expect(decisionsCoverCandidates(1, [decision])).toBe(true);
    expect(decisionsCoverCandidates(2, [decision])).toBe(false);
    expect(decisionsCoverCandidates(2, [decision, decision])).toBe(false);
  });
});
