import { pollAutomations } from './application/automations/poll.ts';
import type { RunFactoryMessage } from './application/factory/message.ts';
import { recoverFactoryStages } from './application/factory/recover.ts';
import { FactoryStageWorkflow, startFactoryStageWorkflow } from './application/factory/workflow.ts';
import { withDatabaseScope } from './data/postgres.ts';
import app from './app.ts';

export { Sandbox } from '@cloudflare/sandbox';
export { LiveUpdates } from './live-updates.ts';
export { DesignJob } from './paper-agent/design-job.ts';
export { ArtifactsEventsWorkflow } from './application/repositories/artifacts-events-workflow.ts';
export { FactoryStageWorkflow };

export default {
  fetch: app.fetch,

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
