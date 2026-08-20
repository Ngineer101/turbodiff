import { describe, expect, it } from 'vite-plus/test';
// Co-located with the pure scheduling policy.
import { computeNextRunAt } from './automation-schedule.ts';

describe('computeNextRunAt', () => {
  it('hourly adds exactly one hour', () => {
    const from = new Date('2026-08-13T10:15:00Z');
    expect(computeNextRunAt({ kind: 'hourly', timeOfDay: null, dayOfWeek: null }, from)).toBe(
      '2026-08-13 11:15:00',
    );
  });

  it('daily picks today when time_of_day is still ahead', () => {
    const from = new Date('2026-08-13T08:00:00Z');
    expect(computeNextRunAt({ kind: 'daily', timeOfDay: '09:00', dayOfWeek: null }, from)).toBe(
      '2026-08-13 09:00:00',
    );
  });

  it('daily rolls to tomorrow when time_of_day already passed today', () => {
    const from = new Date('2026-08-13T10:00:00Z');
    expect(computeNextRunAt({ kind: 'daily', timeOfDay: '09:00', dayOfWeek: null }, from)).toBe(
      '2026-08-14 09:00:00',
    );
  });

  it('weekly picks the correct next weekday, even across a month boundary', () => {
    // 2026-08-31 is a Monday (day 1); the next Wednesday (day 3) falls in September.
    const from = new Date('2026-08-31T12:00:00Z');
    expect(computeNextRunAt({ kind: 'weekly', timeOfDay: '09:00', dayOfWeek: 3 }, from)).toBe(
      '2026-09-02 09:00:00',
    );
  });

  it('weekly stays on the same day when the time is still ahead', () => {
    // 2026-08-13 is a Thursday (day 4).
    const from = new Date('2026-08-13T06:00:00Z');
    expect(computeNextRunAt({ kind: 'weekly', timeOfDay: '09:00', dayOfWeek: 4 }, from)).toBe(
      '2026-08-13 09:00:00',
    );
  });
});
