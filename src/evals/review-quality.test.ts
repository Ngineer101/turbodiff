import { describe, expect, it } from 'vite-plus/test';
import { reviewEvalPasses, scoreReviewEval, type ReviewEvalCase } from './review-quality.ts';

// Seed regressions encode the failure modes seen in review of #158. Replace
// `actual` with captured output from a candidate prompt/model before rollout;
// production false-positive labels should be minimized into new cases here.
const regressions: ReviewEvalCase[] = [
  {
    id: 'fallback-makes-optional-field-safe',
    changedLines: 24,
    expected: [],
    actual: [],
  },
  {
    id: 'cleanup-catch-does-not-swallow-operation',
    changedLines: 18,
    expected: [],
    actual: [],
  },
  {
    id: 'mutation-before-authorization-guard',
    changedLines: 31,
    expected: [{ id: 'route-auth-order', severity: 'P1' }],
    actual: [{ id: 'route-auth-order', severity: 'P1' }],
  },
  {
    id: 'stale-response-overwrites-newer-cache-state',
    changedLines: 47,
    expected: [{ id: 'cache-writer-race', severity: 'P2' }],
    actual: [{ id: 'cache-writer-race', severity: 'P2' }],
  },
];

describe('review quality regression gate', () => {
  it('measures precision, recall, P1 precision, and review density', () => {
    const score = scoreReviewEval(regressions);
    expect(score).toMatchObject({
      truePositives: 2,
      falsePositives: 0,
      falseNegatives: 0,
      precision: 1,
      recall: 1,
      p1Precision: 1,
    });
    expect(score.commentsPerKloc).toBeGreaterThan(0);
    expect(reviewEvalPasses(score)).toBe(true);
  });

  it('fails the rollout gate on one noisy P1', () => {
    const noisy = regressions.map((entry) => ({ ...entry, actual: [...entry.actual] }));
    noisy[0].actual.push({ id: 'invented-api-risk', severity: 'P1' });
    expect(reviewEvalPasses(scoreReviewEval(noisy))).toBe(false);
  });
});
