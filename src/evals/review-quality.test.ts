import { describe, expect, it } from 'vite-plus/test';
import { reviewEvalPasses, scoreReviewEval, type ReviewEvalScore } from './review-quality.ts';

describe('review quality scoring', () => {
  it('penalizes false alarms, misses, duplicate comments, and missed P1 severity', () => {
    const score = scoreReviewEval([
      {
        id: 'mixed-review',
        changedLines: 100,
        expected: [
          { id: 'auth-bypass', severity: 'P1' },
          { id: 'stale-cache', severity: 'P2' },
        ],
        actual: [
          { id: 'auth-bypass', severity: 'P1' },
          { id: 'invented-risk', severity: 'P1' },
          { id: 'stale-cache', severity: 'P1' },
          { id: 'stale-cache', severity: 'P2' },
        ],
      },
      {
        id: 'p1-recall',
        changedLines: 100,
        expected: [
          { id: 'missed-p1', severity: 'P1' },
          { id: 'understated-p1', severity: 'P1' },
        ],
        actual: [{ id: 'understated-p1', severity: 'P2' }],
      },
    ]);

    expect(score).toEqual({
      truePositives: 3,
      falsePositives: 2,
      falseNegatives: 1,
      precision: 3 / 5,
      recall: 3 / 4,
      p1Precision: 1 / 3,
      p1Recall: 1 / 3,
      commentsPerKloc: 25,
    });
  });

  it('enforces every rollout threshold at its boundary', () => {
    const passing: ReviewEvalScore = {
      truePositives: 1,
      falsePositives: 0,
      falseNegatives: 0,
      precision: 0.9,
      recall: 0.8,
      p1Precision: 0.95,
      p1Recall: 0.9,
      commentsPerKloc: 1,
    };
    expect(reviewEvalPasses(passing)).toBe(true);
    for (const metric of ['precision', 'recall', 'p1Precision', 'p1Recall'] as const) {
      expect(reviewEvalPasses({ ...passing, [metric]: passing[metric] - 0.01 })).toBe(false);
    }
  });
});
