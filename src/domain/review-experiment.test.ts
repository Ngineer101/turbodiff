import { describe, expect, it } from 'vite-plus/test';
import { weightedReviewModel } from './review-experiment.ts';

describe('review model experiments', () => {
  it('keeps the configured fallback when no weights are enabled', () => {
    expect(
      weightedReviewModel('repo:1', 'scout', [{ model: 'model/a', weight: 0 }], 'model/base'),
    ).toEqual({ model: 'model/base', experimental: false });
  });

  it('assigns the same review key deterministically', () => {
    const candidates = [
      { model: 'model/a', weight: 1 },
      { model: 'model/b', weight: 1 },
    ];
    expect(weightedReviewModel('repo:1:head', 'verifier', candidates, 'model/base')).toEqual(
      weightedReviewModel('repo:1:head', 'verifier', candidates, 'model/base'),
    );
  });

  it('keeps scout and verifier assignment streams independent', () => {
    const candidates = [
      { model: 'model/a', weight: 1 },
      { model: 'model/b', weight: 1 },
      { model: 'model/c', weight: 1 },
    ];
    const assignments = Array.from({ length: 20 }, (_, index) => ({
      scout: weightedReviewModel(String(index), 'scout', candidates, 'base').model,
      verifier: weightedReviewModel(String(index), 'verifier', candidates, 'base').model,
    }));
    expect(assignments.some((assignment) => assignment.scout !== assignment.verifier)).toBe(true);
  });
});
