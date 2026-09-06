import { describe, expect, it, vi } from 'vite-plus/test';
import { findingSeverity } from './review-findings.ts';

const finding = (severity: 'P1' | 'P2', body: string) => ({
  path: 'src/example.ts',
  line: 42,
  severity,
  body,
});

describe('findingSeverity', () => {
  it('keeps a conformant P2 at P2', () => {
    expect(findingSeverity(finding('P2', '🟡 **P2** missing log on the failure path'))).toBe('P2');
  });

  it('keeps a conformant P1 at P1', () => {
    expect(findingSeverity(finding('P1', '🔴 **P1** drops writes under concurrent pushes'))).toBe(
      'P1',
    );
  });

  it('does not promote a P2 decorated with a red emoji', () => {
    // The PR #147 loop: an agent painted 🔴 on a P2 nit, the promoted finding
    // turned the review blocking, and the repair cycle re-armed every round.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(findingSeverity(finding('P2', '🔴 **P2** missing log on the failure path'))).toBe('P2');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('promotes a body tagged **P1** over a mislabeled P2 field, with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(findingSeverity(finding('P2', '🔴 **P1** leaks the installation token'))).toBe('P1');
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('trusts a P1 field even when the body forgot its tag', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(findingSeverity(finding('P1', 'unauthenticated route exposes the ledger'))).toBe('P1');
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
