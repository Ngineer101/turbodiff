import { env } from 'cloudflare:workers';
import { computeNextRunAt, type ScheduleInput } from './automation-schedule.ts';
import { claimAutomation, listDueAutomations } from './db.ts';

function sqlUtcNow(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

// Called from the `scheduled` handler in src/cloudflare.ts (a fixed-interval
// Cron Trigger — see wrangler.jsonc). Finds automations due to fire, claims
// each atomically (advancing next_run_at so a redelivered/overlapping poll
// can't double-fire it), and enqueues a run. One bad row must never wedge the
// batch, so every item is wrapped individually.
export async function pollAutomations(): Promise<void> {
  const now = new Date();
  const nowIso = sqlUtcNow(now);
  const due = await listDueAutomations(nowIso);
  for (const automation of due) {
    try {
      const schedule: ScheduleInput = {
        // SAFETY: automation rows are only written through the API routes,
        // which reject any schedule_kind outside hourly | daily | weekly
        // before insert/update (SCHEDULE_KINDS in src/routes/api.ts).
        kind: automation.schedule_kind as ScheduleInput['kind'],
        timeOfDay: automation.time_of_day,
        dayOfWeek: automation.day_of_week,
      };
      const nextRunAt = computeNextRunAt(schedule, now);
      const claimed = await claimAutomation(automation.id, nextRunAt, nowIso);
      if (!claimed) continue; // another poll already claimed this one
      await env.FACTORY_QUEUE.send({ kind: 'automation', automationId: automation.id });
    } catch (err) {
      console.error(`turbodiff: automation poll failed for automation ${automation.id}:`, err);
    }
  }
}
