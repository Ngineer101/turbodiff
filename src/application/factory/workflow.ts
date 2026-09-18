import { env, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { withDatabaseScope } from '../../data/postgres.ts';
import { executeFactoryStage, failFactoryStageInfrastructure } from './execute.ts';
import { parseRunFactoryMessage, type RunFactoryMessage } from './message.ts';
import { startFactoryStageWorkflowWithBinding } from './workflow-start.ts';

export class FactoryStageWorkflow extends WorkflowEntrypoint<unknown, RunFactoryMessage> {
  async run(event: WorkflowEvent<RunFactoryMessage>, step: WorkflowStep): Promise<string> {
    const message = parseRunFactoryMessage(event.payload);
    try {
      await step.do(
        `execute factory stage ${message.stageRunId}`,
        { retries: { limit: 2, delay: '1 minute', backoff: 'exponential' }, timeout: '35 minutes' },
        () => withDatabaseScope(() => executeFactoryStage(message)),
      );
      return 'complete';
    } catch (failure) {
      const error = failure instanceof Error ? failure : new Error('Factory infrastructure failed');
      await withDatabaseScope(() => failFactoryStageInfrastructure(message, error));
      return 'failed';
    }
  }
}

export async function startFactoryStageWorkflow(message: RunFactoryMessage): Promise<void> {
  await startFactoryStageWorkflowWithBinding(env.FACTORY_STAGE_WORKFLOW, message);
}
