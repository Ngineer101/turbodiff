import { env, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { getPlan, updatePlan } from '../../data/db.ts';
import { runPlanAnalyze, runPlanRefine } from '../runners/planner.ts';
import { notifyPlanLive } from '../../services/live-updates.ts';
import type { PlanQueueMessage } from '../../shared/factory-messages.ts';

// Planning can run analysis and synthesis back-to-back. It must not inherit
// the queue consumer's 15-minute wall clock. Paid work is not auto-retried:
// a failed attempt remains visible for an explicit user retry.
export class PlanningWorkflow extends WorkflowEntrypoint<unknown, PlanQueueMessage> {
  async run(event: WorkflowEvent<PlanQueueMessage>, step: WorkflowStep): Promise<void> {
    const { planId, kind } = event.payload;
    try {
      await step.do(
        'run planning',
        { retries: { limit: 0, delay: '1 second' }, timeout: '75 minutes' },
        async () => {
          const plan = await getPlan(planId);
          const expected = kind === 'plan_analyze' ? 'analyzing' : 'refining';
          if (!plan || plan.status !== expected) return;
          if (kind === 'plan_analyze') await runPlanAnalyze(planId);
          else await runPlanRefine(planId);
        },
      );
    } catch (error) {
      await step.do('record planning failure', async () => {
        const plan = await getPlan(planId);
        if (plan && (plan.status === 'analyzing' || plan.status === 'refining')) {
          await updatePlan(planId, {
            status: 'failed',
            error:
              `Planning workflow failed: ${error instanceof Error ? error.message : String(error)}`.slice(
                0,
                500,
              ),
          });
        }
      });
    }
    await step.do('notify planning result', () => notifyPlanLive(planId));
  }
}

export async function startPlanning(message: PlanQueueMessage, deliveryId: string): Promise<void> {
  // createBatch is idempotent for existing instance IDs. Queue redelivery must
  // not start a second paid agent or clear the active planner's workspace.
  await env.PLAN_WORKFLOW.createBatch([
    { id: `plan-${message.planId}-${deliveryId}`, params: message },
  ]);
}
