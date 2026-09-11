import { describe, expect, it } from 'vite-plus/test';
import type { ReviewerInput } from '../agents/reviewer.ts';
import { planReviewPublication } from './review-publication.ts';

const input: ReviewerInput = {
  repository: 'acme/app',
  change: {
    title: 'Change',
    description: '',
    base: 'main',
    head: 'feature',
    revision: 'a'.repeat(40),
    files: [
      { path: 'src/a.ts', reviewable: true, omittedReason: null },
      { path: 'src/b.ts', reviewable: true, omittedReason: null },
      { path: 'pnpm-lock.yaml', reviewable: false, omittedReason: 'lockfile' },
    ],
  },
  focus: { name: 'Correctness', instructions: 'Find real defects.' },
  changedSincePreviousReview: null,
};

describe('review publication planning', () => {
  it('derives coverage and lifecycle verdict from the artifact', () => {
    const plan = planReviewPublication(
      input,
      {
        summary: 'One issue remains.',
        findings: [
          {
            path: 'src/a.ts',
            line: 3,
            side: 'RIGHT',
            severity: 'P1',
            body: 'The mutation runs before authorization.',
            evidence: 'The call order is visible in the changed function.',
            failurePath: 'Anonymous request reaches the mutation.',
          },
        ],
        fileEvidence: [
          { path: 'src/a.ts', disposition: 'reviewed', evidence: 'Checked call order.' },
          { path: 'src/b.ts', disposition: 'blocked', evidence: 'Patch is malformed.' },
        ],
      },
      true,
    );

    expect(plan.event).toBe('REQUEST_CHANGES');
    expect(plan.verdict).toBe('request_changes');
    expect(plan.readiness).toMatchObject({
      conclusion: 'inconclusive',
      coverageStatus: 'incomplete',
      coveredFileCount: 1,
      missingPaths: ['src/b.ts'],
    });
    expect(plan.findings[0]?.body).toMatch(/^🔴 \*\*P1\*\*/u);
  });

  it('drops findings that do not anchor to a reviewable changed path', () => {
    const plan = planReviewPublication(
      input,
      {
        summary: 'No supported findings.',
        findings: [
          {
            path: 'src/unchanged.ts',
            line: 3,
            side: 'RIGHT',
            severity: 'P1',
            body: 'Not part of this change.',
            evidence: 'Outside the manifest.',
            failurePath: 'Not relevant.',
          },
        ],
        fileEvidence: input.change.files
          .filter((file) => file.reviewable)
          .map((file) => ({ path: file.path, disposition: 'reviewed', evidence: 'Checked.' })),
      },
      true,
    );

    expect(plan.findings).toEqual([]);
    expect(plan.verdict).toBe('approve');
  });
});
