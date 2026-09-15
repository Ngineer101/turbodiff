import { claimAutomation, listDueAutomations } from '../../data/automations.ts';
import { createFactoryRunWithStage } from '../../data/execution.ts';
import { createWorkItem } from '../../data/work.ts';
import { withTransaction } from '../../data/postgres.ts';
import { enqueueFactoryMessage } from '../factory/queue.ts';
import { AUTOMATION_FLOW } from '../factory/flows.ts';
import { nextAutomationRunAt } from '../../domain/automation-schedule.ts';

export async function pollAutomations(): Promise<void> {
  const now = new Date();
  for (const automation of await listDueAutomations(now.toISOString())) {
    const nextRunAt = nextAutomationRunAt(automation.schedule, now);
    if (!nextRunAt || !automation.next_run_at) continue;
    const created = await withTransaction(async () => {
      if (!(await claimAutomation(automation.id, automation.next_run_at!, nextRunAt))) return null;
      const workItem = await createWorkItem({
        organizationId: automation.organization_id,
        origin: 'automation',
        title: automation.name,
        description: JSON.stringify(automation.input_template),
        createdByUserId: automation.created_by_user_id,
        repositoryIds: automation.repository_id ? [automation.repository_id] : [],
      });
      const key = `automation:${automation.id}:${automation.next_run_at}`;
      return createFactoryRunWithStage(
        {
          organizationId: automation.organization_id,
          flowKey: AUTOMATION_FLOW.key,
          flowVersion: AUTOMATION_FLOW.version,
          workItemId: workItem.id,
          automationId: automation.id,
          trigger: 'schedule',
          idempotencyKey: key,
        },
        {
          stageKey: AUTOMATION_FLOW.initialStage,
          idempotencyKey: `${key}:${AUTOMATION_FLOW.initialStage}`,
        },
      );
    });
    if (!created) continue;
    try {
      await enqueueFactoryMessage({
        kind: 'run_factory',
        factoryRunId: created.factoryRun.id,
        stageRunId: created.stageRun.id,
      });
    } catch (error) {
      console.warn('turbodiff: automation factory enqueue deferred to recovery', error);
    }
  }
}
