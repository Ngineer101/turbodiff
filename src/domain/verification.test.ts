import { describe, expect, it } from 'vite-plus/test';
import { formatUnmetCriteriaFindings, verificationSkipReason } from './verification.ts';

describe('verificationSkipReason', () => {
  // D1-format timestamps ('YYYY-MM-DD HH:MM:SS', UTC) so the helper's
  // parseUtc path is the one under test.
  const now = Date.parse('2026-08-29T12:00:00Z');

  it('skips terminal features even with no verification row', () => {
    for (const status of ['merged', 'abandoned', 'pr_closed']) {
      expect(verificationSkipReason({ status }, null, now)).toBe('terminal');
    }
  });

  it('skips an open feature while a run is inside the stall window', () => {
    const latest = { status: 'running', created_at: '2026-08-29 11:16:00' }; // 44 min old
    expect(verificationSkipReason({ status: 'pr_opened' }, latest, now)).toBe('in_flight');
  });

  it('dispatches over a running row older than the stall window', () => {
    const latest = { status: 'running', created_at: '2026-08-29 11:14:00' }; // 46 min old
    expect(verificationSkipReason({ status: 'pr_opened' }, latest, now)).toBeNull();
  });

  it('dispatches when the latest run already finished', () => {
    const latest = { status: 'passed', created_at: '2026-08-29 11:59:00' };
    expect(verificationSkipReason({ status: 'pr_opened' }, latest, now)).toBeNull();
  });
});

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
