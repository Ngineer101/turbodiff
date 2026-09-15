import { env, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { withDatabaseScope } from '../../data/postgres.ts';
import type { RunFactoryMessage } from '../../shared/factory-messages.ts';
import { executeFactoryStage, failFactoryStageInfrastructure } from './execute.ts';

function validateMessage(value: RunFactoryMessage): RunFactoryMessage {
  if (
    value.kind !== 'run_factory' ||
    !Number.isSafeInteger(value.factoryRunId) ||
    value.factoryRunId <= 0 ||
    !Number.isSafeInteger(value.stageRunId) ||
    value.stageRunId <= 0
  ) {
    throw new Error('invalid factory workflow message');
  }
  return value;
}

export class FactoryStageWorkflow extends WorkflowEntrypoint<unknown, RunFactoryMessage> {
  async run(event: WorkflowEvent<RunFactoryMessage>, step: WorkflowStep): Promise<string> {
    const message = validateMessage(event.payload);
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
  const validated = validateMessage(message);
  const id = `factory-stage-${validated.stageRunId}`;
  const instance = await env.FACTORY_STAGE_WORKFLOW.get(id);
  const status = await instance.status();
  if (status.status === 'unknown') {
    await env.FACTORY_STAGE_WORKFLOW.create({ id, params: validated });
    return;
  }
  if (status.status === 'errored' || status.status === 'terminated') {
    await instance.restart();
  }
}
