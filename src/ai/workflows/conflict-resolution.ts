import { env, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { processResolveConflictMessage } from '../runners/conflict-resolver.ts';
import type { ConflictResolveQueueMessage } from '../../shared/factory-messages.ts';
import { notifyRepositoryLive } from '../../services/live-updates.ts';

// Conflict resolution runs as a durable Workflow, same as fix — an
// agent-driven merge conflict resolution can exceed a queue consumer's wall
// clock. processResolveConflictMessage records its own outcomes (fix_attempts)
// and never throws for business reasons; the atomic attempt-cap insert
// inside it also dedupes concurrent deliveries, so one long-budget step
// suffices.

export type ConflictResolveParams = {
  message: ConflictResolveQueueMessage;
};

export class ConflictResolveWorkflow extends WorkflowEntrypoint<unknown, ConflictResolveParams> {
  async run(event: WorkflowEvent<ConflictResolveParams>, step: WorkflowStep): Promise<string> {
    await step.do(
      'resolve conflict',
      { retries: { limit: 1, delay: '5 minutes' }, timeout: '40 minutes' },
      async () => {
        await processResolveConflictMessage(event.payload.message);
        await notifyRepositoryLive(event.payload.message.repoId);
      },
    );
    return 'done';
  }
}

export async function startResolveConflict(message: ConflictResolveQueueMessage): Promise<void> {
  await env.CONFLICT_RESOLVE_WORKFLOW.create({
    id: `resolve-conflict-${message.repoId}-${message.prNumber}-${Date.now()}`,
    params: { message },
  });
}
