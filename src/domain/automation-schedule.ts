// Domain policy: pure date arithmetic for automation scheduling — no `env` import, so this
// runs under Vitest without the Workers runtime (see vitest.config.ts).
// Time-of-day is UTC only for v1 (no per-automation timezone setting).

export interface ScheduleInput {
  kind: 'hourly' | 'daily' | 'weekly';
  timeOfDay: string | null; // 'HH:MM' UTC
  dayOfWeek: number | null; // 0 (Sun) - 6 (Sat)
}

function toSqlUtc(date: Date): string {
  return date.toISOString();
}

// Next UTC occurrence of `hour:minute` strictly after `from` (today if it
// hasn't passed yet today, else tomorrow).
function nextTimeOfDay(from: Date, hour: number, minute: number): Date {
  const next = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), hour, minute, 0),
  );
  if (next.getTime() <= from.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

export function computeNextRunAt(schedule: ScheduleInput, from: Date): string {
  if (schedule.kind === 'hourly') {
    return toSqlUtc(new Date(from.getTime() + 60 * 60_000));
  }

  const [hour, minute] = (schedule.timeOfDay ?? '00:00').split(':').map(Number);

  if (schedule.kind === 'daily') {
    return toSqlUtc(nextTimeOfDay(from, hour, minute));
  }

  // weekly: the next occurrence of dayOfWeek at hour:minute, strictly after `from`.
  const targetDay = schedule.dayOfWeek ?? 0;
  let next = nextTimeOfDay(from, hour, minute);
  while (next.getUTCDay() !== targetDay) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return toSqlUtc(next);
}

export function parseAutomationSchedule(value: string): ScheduleInput | null {
  const parts = value.trim().toLowerCase().split(/\s+/);
  if (parts.length === 1 && parts[0] === 'hourly') {
    return { kind: 'hourly', timeOfDay: null, dayOfWeek: null };
  }
  if (parts.length === 2 && parts[0] === 'daily' && /^([01]\d|2[0-3]):[0-5]\d$/.test(parts[1]!)) {
    return { kind: 'daily', timeOfDay: parts[1]!, dayOfWeek: null };
  }
  if (
    parts.length === 3 &&
    parts[0] === 'weekly' &&
    /^[0-6]$/.test(parts[1]!) &&
    /^([01]\d|2[0-3]):[0-5]\d$/.test(parts[2]!)
  ) {
    return { kind: 'weekly', dayOfWeek: Number(parts[1]), timeOfDay: parts[2]! };
  }
  return null;
}

export function nextAutomationRunAt(value: string, from: Date): string | null {
  const schedule = parseAutomationSchedule(value);
  return schedule ? computeNextRunAt(schedule, from) : null;
}
