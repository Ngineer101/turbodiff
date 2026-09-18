import type { RunFactoryMessage } from './message.ts';
import { parseRunFactoryMessage } from './message.ts';

type FactoryStageWorkflowInstance = Pick<WorkflowInstance, 'restart' | 'status'>;

export interface FactoryStageWorkflowBinding {
  createBatch(
    batch: Parameters<Workflow<RunFactoryMessage>['createBatch']>[0],
  ): Promise<FactoryStageWorkflowInstance[]>;
  get(id: string): Promise<FactoryStageWorkflowInstance>;
}

export async function startFactoryStageWorkflowWithBinding(
  workflow: FactoryStageWorkflowBinding,
  message: RunFactoryMessage,
): Promise<void> {
  const validated = parseRunFactoryMessage(message);
  const id = `factory-stage-${validated.stageRunId}`;
  const created = await workflow.createBatch([{ id, params: validated }]);
  if (created.length > 0) return;

  const instance = await workflow.get(id);
  const status = await instance.status();
  if (status.status === 'errored' || status.status === 'terminated') {
    await instance.restart();
  }
}
