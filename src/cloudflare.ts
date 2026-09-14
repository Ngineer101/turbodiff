import { pollAutomations } from './application/automations/poll.ts';
import { recoverFactoryStages } from './application/factory/recover.ts';
import { FactoryStageWorkflow, startFactoryStageWorkflow } from './application/factory/workflow.ts';
import { withDatabaseScope } from './data/database.ts';
import type { RunFactoryMessage } from './shared/factory-messages.ts';

export { Sandbox } from '@cloudflare/sandbox';
export { LiveUpdates } from './live-updates.ts';
export { ArtifactsEventsWorkflow } from './ai/workflows/artifacts-events.ts';
export { FactoryStageWorkflow };

export default {
  async queue(batch: MessageBatch<RunFactoryMessage>): Promise<void> {
    await withDatabaseScope(async () => {
      for (const message of batch.messages) {
        await startFactoryStageWorkflow(message.body);
        message.ack();
      }
    });
  },

  async scheduled(): Promise<void> {
    await withDatabaseScope(async () => {
      await pollAutomations();
      await recoverFactoryStages();
    });
  },
};
