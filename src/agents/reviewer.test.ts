import { describe, expect, it } from 'vite-plus/test';
import { reviewArtifactSchema } from '../artifacts/review.ts';
import { reviewerAgent, type ReviewerInput } from './reviewer.ts';

const input: ReviewerInput = {
  repository: 'acme/app',
  change: {
    title: 'Make updates atomic',
    description: 'Prevents readers from observing partial state.',
    base: 'main',
    head: 'atomic-updates',
    revision: 'a'.repeat(40),
    files: [
      { path: 'src/state.ts', reviewable: true, omittedReason: null },
      { path: 'pnpm-lock.yaml', reviewable: false, omittedReason: 'lockfile' },
    ],
  },
  focus: {
    name: 'Concurrency & State',
    instructions: 'Find races and non-atomic state transitions.',
  },
  changedSincePreviousReview: null,
};

describe('reviewer agent', () => {
  it('is a provider-neutral read-only agent with a review artifact output', () => {
    const parsed = reviewerAgent.input.parse(input);

    expect(reviewerAgent.id).toBe('reviewer');
    expect(reviewerAgent.repositoryAccess).toBe('read');
    expect(reviewerAgent.output(parsed)).toBe(reviewArtifactSchema);
    expect(() => reviewerAgent.input.parse({ ...input, provider: 'github' })).toThrow();
  });

  it('contains review policy without transport or publication instructions', () => {
    const prompt = reviewerAgent.prompt(input);

    expect(prompt).toContain('Review the supplied change in acme/app');
    expect(prompt).toContain('Find races and non-atomic state transitions.');
    expect(prompt).toContain('exactly one entry for every reviewable changed path');
    expect(prompt).toContain('Actively try to disprove each candidate finding');
    expect(prompt).not.toContain('GitHub');
    expect(prompt).not.toContain('post_review');
    expect(prompt).not.toContain('fetch_pr');
  });
});
