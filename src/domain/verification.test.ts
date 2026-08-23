import { describe, expect, it } from 'vite-plus/test';
import { formatUnmetCriteriaFindings } from './verification.ts';

describe('formatUnmetCriteriaFindings', () => {
  it('formats only failed criteria, preserving the fix work-order shape', () => {
    const out = formatUnmetCriteriaFindings(
      ['login works', 'logout works', 'session expires'],
      [
        { index: 0, verdict: 'pass', note: 'ok' },
        { index: 1, verdict: 'fail', note: 'logout returns 500' },
        { index: 2, verdict: 'skip', note: 'not reachable' },
      ],
    );
    expect(out).toContain('**P1** — Acceptance criterion not met: logout works');
    expect(out).toContain('Evidence: logout returns 500');
    expect(out).not.toContain('login works');
    expect(out).not.toContain('session expires');
  });

  it('returns an empty string when everything passed', () => {
    expect(formatUnmetCriteriaFindings(['a'], [{ index: 0, verdict: 'pass', note: '' }])).toBe('');
  });
});
