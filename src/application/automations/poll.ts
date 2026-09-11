import { computeNextRunAt, type ScheduleInput } from '../../domain/automation-schedule.ts';
import { claimAutomation, listDueAutomations } from '../../data/db.ts';
import { enqueueFactoryMessage } from '../factory/queue.ts';

export async function pollAutomations(): Promise<void> {
  const now = new Date();
  const nowIso = now.toISOString();
  const due = await listDueAutomations(nowIso);
  for (const automation of due) {
    try {
      const schedule: ScheduleInput = {
        // SAFETY: persisted schedule kinds are validated before writes.
        kind: automation.schedule_kind as ScheduleInput['kind'],
        timeOfDay: automation.time_of_day,
        dayOfWeek: automation.day_of_week,
      };
      const nextRunAt = computeNextRunAt(schedule, now);
      const claimed = await claimAutomation(automation.id, nextRunAt, nowIso);
      if (!claimed) continue; // another poll already claimed this one
      await enqueueFactoryMessage({ kind: 'automation', automationId: automation.id });
    } catch (err) {
      console.error(`turbodiff: automation poll failed for automation ${automation.id}:`, err);
    }
  }
}
