import { describe, expect, it } from 'vite-plus/test';
import {
  formatUnmetCriteriaFindings,
  gradedCriteria,
  verdictRecordedSince,
  verificationSkipReason,
  verifyStageOutcome,
} from './verification.ts';

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

describe('verdictRecordedSince', () => {
  const queuedAt = Date.parse('2026-09-07T20:02:23Z');

  it('reuses a terminal verdict recorded after the instance was queued', () => {
    for (const status of ['passed', 'failed']) {
      const latest = { status, created_at: '2026-09-07 20:02:27' };
      expect(verdictRecordedSince(latest, queuedAt)).toBe(true);
    }
  });

  it('tolerates the database clock running slightly behind the engine', () => {
    const latest = { status: 'failed', created_at: '2026-09-07 20:01:40' };
    expect(verdictRecordedSince(latest, queuedAt)).toBe(true);
  });

  it('re-runs over a verdict that predates the instance', () => {
    const latest = { status: 'failed', created_at: '2026-09-07 19:30:00' };
    expect(verdictRecordedSince(latest, queuedAt)).toBe(false);
  });

  it('re-runs over a dead earlier attempt and with no row at all', () => {
    for (const status of ['running', 'error']) {
      const latest = { status, created_at: '2026-09-07 20:02:27' };
      expect(verdictRecordedSince(latest, queuedAt)).toBe(false);
    }
    expect(verdictRecordedSince(null, queuedAt)).toBe(false);
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

describe('gradedCriteria', () => {
  const acceptance = ['GET /a returns 200', 'POST /b validates its body'];

  it('pairs stored criteria with their results by index and keeps ungraded rows', () => {
    const rows = gradedCriteria(acceptance, [{ index: 1, verdict: 'pass', note: 'ok' }]);
    expect(rows).toEqual([
      { text: acceptance[0], result: null },
      { text: acceptance[1], result: { index: 1, verdict: 'pass', note: 'ok' } },
    ]);
  });

  it('keeps rows a verification recorded beyond the stored criteria, labeled as retired', () => {
    const appended = { index: 2, verdict: 'fail', note: 'Surviving mechanism: …' } as const;
    const rows = gradedCriteria(acceptance, [
      { index: 0, verdict: 'pass', note: 'ok' },
      { index: 1, verdict: 'pass', note: 'ok' },
      appended,
    ]);
    expect(rows).toHaveLength(3);
    expect(rows[2]).toEqual({ text: 'Verification check #3 (retired)', result: appended });
    expect(
      gradedCriteria(['only'], [{ index: 2, verdict: 'pass', note: 'x' }]).map((r) => r.text),
    ).toEqual(['only', 'Verification check #3 (retired)']);
  });
});

describe('formatUnmetCriteriaFindings', () => {
  it('names a retired appended row when it is the failing one', () => {
    const findings = formatUnmetCriteriaFindings(
      ['stored criterion'],
      [
        { index: 0, verdict: 'pass', note: 'ok' },
        { index: 1, verdict: 'fail', note: 'Surviving mechanism: X' },
      ],
    );
    expect(findings).toContain('not met: Verification check #2 (retired)');
    expect(findings).toContain('Evidence: Surviving mechanism: X');
    expect(findings).not.toContain('undefined');
  });
});

describe('verifyStageOutcome', () => {
  it('completes the stage on a verdict and carries it as a fact', () => {
    expect(verifyStageOutcome('passed')).toEqual({
      success: true,
      facts: { verificationPassed: true },
    });
    expect(verifyStageOutcome('failed')).toEqual({
      success: true,
      facts: { verificationPassed: false },
    });
  });

  it('fails the stage without a verdict fact when the run errored or never recorded', () => {
    for (const status of ['error', 'running', null, undefined]) {
      expect(verifyStageOutcome(status)).toEqual({ success: false, facts: {} });
    }
  });
});
