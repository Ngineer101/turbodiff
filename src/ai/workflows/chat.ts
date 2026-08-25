import { env, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { processChatMessage } from '../runners/chat.ts';
import type { ChatQueueMessage } from '../../shared/factory-messages.ts';

// Chat turns run as a durable Workflow, mirroring FixWorkflow: the sandbox
// work (clone/refresh + agent + tests + repair rounds) routinely exceeds the
// queue consumer's wall clock. processChatMessage records its own outcomes
// (chat_messages + fix_attempts) and never throws for business reasons — the
// retry only covers infrastructure crashes, and its status = 'queued' gate
// (a 'running' row on retry fails closed) prevents a double paid run.

export type ChatParams = {
  message: ChatQueueMessage;
};

export class ChatWorkflow extends WorkflowEntrypoint<unknown, ChatParams> {
  async run(event: WorkflowEvent<ChatParams>, step: WorkflowStep): Promise<string> {
    await step.do(
      'run chat turn',
      // Budget covers the worst case: clone + install + agent + tests, plus
      // up to REPAIR_ROUNDS repair/re-test cycles (see runners/chat.ts).
      { retries: { limit: 1, delay: '5 minutes' }, timeout: '85 minutes' },
      async () => {
        await processChatMessage(event.payload.message);
      },
    );
    return 'done';
  }
}

export async function startChatTurn(message: ChatQueueMessage): Promise<void> {
  await env.CHAT_WORKFLOW.create({
    id: `chat-${message.featureId}-${message.chatMessageId}-${Date.now()}`,
    params: { message },
  });
}
