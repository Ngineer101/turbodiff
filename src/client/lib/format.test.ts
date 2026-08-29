import { describe, expect, it } from 'vite-plus/test';
import { ago, fmtDuration, fmtTokens, fmtUsd, parseUtc } from './format.ts';

describe('fmtUsd', () => {
  it('scales precision with magnitude', () => {
    expect(fmtUsd(12.844)).toBe('$12.84');
    expect(fmtUsd(0.42)).toBe('$0.420');
    expect(fmtUsd(0.0031)).toBe('$0.0031');
    expect(fmtUsd(0)).toBe('$0.00');
  });
});

describe('fmtTokens', () => {
  it('abbreviates into K/M buckets', () => {
    expect(fmtTokens(999)).toBe('999');
    expect(fmtTokens(1_500)).toBe('1.5K');
    expect(fmtTokens(22_101)).toBe('22K');
    expect(fmtTokens(9_412_331)).toBe('9.4M');
  });
});

describe('fmtDuration', () => {
  it('renders seconds under a minute, m s above', () => {
    expect(fmtDuration(48)).toBe('48s');
    expect(fmtDuration(141)).toBe('2m 21s');
    expect(fmtDuration(0)).toBe('1s');
  });
});

describe('ago', () => {
  it('buckets an ISO UTC timestamp into s/m/h/d', () => {
    const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
    expect(ago(at(30_000))).toBe('30s ago');
    expect(ago(at(5 * 60_000))).toBe('5m ago');
    expect(ago(at(3 * 3_600_000))).toBe('3h ago');
    expect(ago(at(2 * 86_400_000))).toBe('2d ago');
  });
});

describe('parseUtc', () => {
  it('reads ISO UTC timestamps', () => {
    expect(parseUtc('2026-08-07T12:00:00.000Z')).toBe(Date.parse('2026-08-07T12:00:00Z'));
  });

  it('reads raw node-postgres timestamptz output without corrupting its offset', () => {
    expect(parseUtc('2026-08-28 10:00:00.123456+00')).toBe(Date.parse('2026-08-28T10:00:00.123Z'));
  });

  it('treats legacy zone-less database timestamps as UTC', () => {
    expect(parseUtc('2026-08-28 10:00:00')).toBe(Date.parse('2026-08-28T10:00:00Z'));
  });
});
