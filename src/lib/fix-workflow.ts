import { env, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { processFixMessage, type FixQueueMessage } from './fixer.ts';

// Fix runs as a durable Workflow — the last of the three long agent runs
// (generation, verification, fix) to leave the queue consumer's 15-minute
// wall clock. processFixMessage records its own outcomes (fix_attempts) and
// never throws for business reasons; the atomic attempt-cap insert inside it
// also dedupes concurrent deliveries, so one long-budget step suffices.

export type FixParams = {
  message: FixQueueMessage;
};

export class FixWorkflow extends WorkflowEntrypoint<unknown, FixParams> {
  async run(event: WorkflowEvent<FixParams>, step: WorkflowStep): Promise<string> {
    await step.do(
      'run fix',
      // Budget covers the worst case: clone + install + agent + tests, plus
      // up to REPAIR_ROUNDS repair/re-test cycles (see fixer.ts).
      { retries: { limit: 1, delay: '5 minutes' }, timeout: '85 minutes' },
      async () => {
        await processFixMessage(event.payload.message);
      },
    );
    return 'done';
  }
}

export async function startFix(message: FixQueueMessage): Promise<void> {
  await env.FIX_WORKFLOW.create({
    id: `fix-${message.repoId}-${message.prNumber}-${Date.now()}`,
    params: { message },
  });
}
