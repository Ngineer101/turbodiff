import { describe, expect, it } from 'vite-plus/test';
import { autoMergeDecline, type AutoMergeFacts } from './merge-policy.ts';

const GREEN: AutoMergeFacts = {
  optedIn: true,
  blockingReviews: true,
  hasAcceptanceCriteria: true,
  verificationPassed: true,
  reviewed: true,
  anyBlockingReview: false,
  checksGreen: true,
  hasConflict: false,
};

describe('autoMergeDecline', () => {
  it('merges only when every gate is green', () => {
    expect(autoMergeDecline(GREEN)).toBeNull();
  });

  it('declines on each individual gate', () => {
    expect(autoMergeDecline({ ...GREEN, optedIn: false })).toContain('disabled');
    expect(autoMergeDecline({ ...GREEN, blockingReviews: false })).toContain('blocking');
    expect(autoMergeDecline({ ...GREEN, hasAcceptanceCriteria: false })).toContain('acceptance');
    expect(autoMergeDecline({ ...GREEN, verificationPassed: false })).toContain('verification');
    expect(autoMergeDecline({ ...GREEN, reviewed: false })).toContain('review');
    expect(autoMergeDecline({ ...GREEN, anyBlockingReview: true })).toContain('requested changes');
    expect(autoMergeDecline({ ...GREEN, checksGreen: false })).toContain('checks');
    expect(autoMergeDecline({ ...GREEN, hasConflict: true })).toContain('conflict');
  });
});
