import { describe, expect, it } from 'vite-plus/test';
import { reviewReadinessReport, type ReviewReadinessEvidence } from './review-readiness.ts';

const ready: ReviewReadinessEvidence = {
  agentSlug: 'review',
  status: 'completed',
  conclusion: 'ready',
  coveredFileCount: 4,
  reviewableFileCount: 4,
  missingPaths: [],
  findingsCount: 0,
  error: null,
};

describe('reviewReadinessReport', () => {
  it('passes only when every required reviewer is conclusive', () => {
    expect(reviewReadinessReport([ready])).toMatchObject({
      conclusion: 'ready',
      checkConclusion: 'success',
    });
    expect(
      reviewReadinessReport([
        ready,
        { ...ready, agentSlug: 'security', conclusion: 'inconclusive', missingPaths: ['auth.ts'] },
      ]),
    ).toMatchObject({ conclusion: 'inconclusive', checkConclusion: 'failure' });
  });

  it('keeps verified blocking findings distinct from missing evidence', () => {
    expect(
      reviewReadinessReport([{ ...ready, conclusion: 'not_ready', findingsCount: 1 }]),
    ).toMatchObject({
      conclusion: 'not_ready',
      checkConclusion: 'failure',
      title: 'Review gate failed',
    });
    expect(reviewReadinessReport([])).toMatchObject({
      conclusion: 'inconclusive',
      checkConclusion: 'failure',
    });
  });
});
