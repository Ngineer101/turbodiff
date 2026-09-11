import { describe, expect, it } from 'vite-plus/test';
import { reviewArtifactSchema } from './review.ts';

const finding = {
  path: 'src/task.ts',
  line: 12,
  body: 'The rejected promise leaves the operation pending.',
  evidence: 'The call returns a promise and has no rejection handler.',
  failurePath: 'The request rejects, which leaves the operation pending.',
};

describe('review artifacts', () => {
  it('materializes collection and finding defaults', () => {
    expect(reviewArtifactSchema.parse({ summary: 'The change needs one fix.' })).toEqual({
      summary: 'The change needs one fix.',
      findings: [],
      fileEvidence: [],
    });

    expect(
      reviewArtifactSchema.parse({
        summary: 'The change needs one fix.',
        findings: [finding],
      }).findings[0],
    ).toEqual({ ...finding, side: 'RIGHT', severity: 'P2' });
  });

  it('accepts the explicit bounded payload contract', () => {
    const evidence = 'x'.repeat(1_000);
    expect(
      reviewArtifactSchema.parse({
        summary: 'A focused review.',
        findings: [{ ...finding, side: 'LEFT', startLine: 10, severity: 'P1' }],
        fileEvidence: [{ path: 'p'.repeat(1_000), disposition: 'blocked', evidence }],
      }),
    ).toMatchObject({
      findings: [{ side: 'LEFT', startLine: 10, severity: 'P1' }],
      fileEvidence: [{ disposition: 'blocked', evidence }],
    });
  });

  it.each([
    { summary: '' },
    { summary: 'Review', extra: true },
    { summary: 'Review', findings: [{ ...finding, path: '' }] },
    { summary: 'Review', findings: [{ ...finding, line: 0 }] },
    { summary: 'Review', findings: [{ ...finding, line: 1.5 }] },
    { summary: 'Review', findings: [{ ...finding, startLine: 12 }] },
    { summary: 'Review', findings: [{ ...finding, side: 'CENTER' }] },
    { summary: 'Review', findings: [{ ...finding, severity: 'P3' }] },
    { summary: 'Review', findings: [{ ...finding, body: '' }] },
    { summary: 'Review', findings: [{ ...finding, evidence: '' }] },
    { summary: 'Review', findings: [{ ...finding, failurePath: '' }] },
    {
      summary: 'Review',
      fileEvidence: [{ path: '', disposition: 'reviewed', evidence: 'Checked.' }],
    },
    {
      summary: 'Review',
      fileEvidence: [{ path: 'p'.repeat(1_001), disposition: 'reviewed', evidence: 'Checked.' }],
    },
    {
      summary: 'Review',
      fileEvidence: [{ path: 'src/task.ts', disposition: 'skipped', evidence: 'Checked.' }],
    },
    {
      summary: 'Review',
      fileEvidence: [{ path: 'src/task.ts', disposition: 'reviewed', evidence: '' }],
    },
    {
      summary: 'Review',
      fileEvidence: [
        { path: 'src/task.ts', disposition: 'reviewed', evidence: 'Checked.' },
        { path: 'src/task.ts', disposition: 'blocked', evidence: 'Could not check.' },
      ],
    },
  ])('rejects an invalid review artifact: %#', (candidate) => {
    expect(reviewArtifactSchema.safeParse(candidate).success).toBe(false);
  });
});
