import { describe, expect, it } from 'vite-plus/test';
import { weightedReviewModel } from './review-experiment.ts';

describe('review model experiments', () => {
  it('keeps the configured fallback when no weights are enabled', () => {
    expect(
      weightedReviewModel('repo:1', 'scout', [{ model: 'model/a', weight: 0 }], 'model/base'),
    ).toEqual({ model: 'model/base', experimental: false });
  });

  it('keeps a review in the same cohort across retries', () => {
    const candidates = [
      { model: 'model/a', weight: 1 },
      { model: 'model/b', weight: 1 },
    ];
    const assignment = weightedReviewModel('repo:1:head', 'verifier', candidates, 'model/base');
    expect(assignment).toEqual({ model: 'model/a', experimental: true });
    expect(weightedReviewModel('repo:1:head', 'verifier', candidates, 'model/base')).toEqual(
      assignment,
    );
  });

  it('never assigns a zero-weight model', () => {
    const candidates = [
      { model: 'disabled', weight: 0 },
      { model: 'enabled', weight: 10 },
    ];
    for (let index = 0; index < 20; index += 1) {
      expect(weightedReviewModel(String(index), 'scout', candidates, 'base')).toEqual({
        model: 'enabled',
        experimental: true,
      });
    }
  });

  it('salts scout and verifier cohorts independently', () => {
    const candidates = [
      { model: 'a', weight: 1 },
      { model: 'b', weight: 1 },
      { model: 'c', weight: 1 },
    ];
    expect(weightedReviewModel('repo:1:head', 'scout', candidates, 'base').model).toBe('a');
    expect(weightedReviewModel('repo:1:head', 'verifier', candidates, 'base').model).toBe('b');
  });
});
