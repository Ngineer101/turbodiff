import { pollAutomations } from './application/automations/poll.ts';
import {
  reconcilePendingAiGatewayUsage,
  trackAiGatewayUsage,
} from './application/ai-gateway-usage.ts';
import { recoverFactoryStages } from './application/factory/recover.ts';
import { FactoryStageWorkflow, startFactoryStageWorkflow } from './application/factory/workflow.ts';
import { consumeWorkerQueueMessage, type WorkerQueueMessage } from './application/queue-message.ts';
import { withDatabaseScope } from './data/postgres.ts';
import app from './app.ts';

export { Sandbox } from '@cloudflare/sandbox';
export { LiveUpdates } from './live-updates.ts';
export { ArtifactsEventsWorkflow } from './application/repositories/artifacts-events-workflow.ts';
export { FactoryStageWorkflow };

export default {
  fetch: app.fetch,

  async queue(batch: MessageBatch<WorkerQueueMessage>): Promise<void> {
    await withDatabaseScope(async () => {
      for (const message of batch.messages) {
        const reason = await consumeWorkerQueueMessage(message, {
          startFactoryStage: startFactoryStageWorkflow,
          trackAiGatewayUsage,
        });
        if (reason) {
          console.warn(
            JSON.stringify({
              message: 'turbodiff: AI Gateway usage queue delivery deferred',
              queueMessageId: message.id,
              attempts: message.attempts,
              reason,
            }),
          );
        }
      }
    });
  },

  async scheduled(): Promise<void> {
    await withDatabaseScope(async () => {
      await pollAutomations();
      await recoverFactoryStages();
      await reconcilePendingAiGatewayUsage();
    });
  },
};
