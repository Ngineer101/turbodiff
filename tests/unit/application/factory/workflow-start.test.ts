import { describe, expect, it } from 'vite-plus/test';
import type { RunFactoryMessage } from '../../../../src/application/factory/message.ts';
import {
  type FactoryStageWorkflowBinding,
  startFactoryStageWorkflowWithBinding,
} from '../../../../src/application/factory/workflow-start.ts';

const message: RunFactoryMessage = {
  kind: 'run_factory',
  factoryRunId: 41,
  stageRunId: 73,
};

type WorkflowStatus = Awaited<
  ReturnType<Awaited<ReturnType<FactoryStageWorkflowBinding['get']>>['status']>
>['status'];

function fakeWorkflow(status: WorkflowStatus, created: boolean) {
  const createBatch: Parameters<FactoryStageWorkflowBinding['createBatch']>[0][] = [];
  const get: string[] = [];
  const calls = {
    createBatch,
    get,
    restart: 0,
  };
  const instance = {
    id: 'factory-stage-73',
    status: async () => ({ status }),
    restart: async () => {
      calls.restart += 1;
    },
  };
  const workflow: FactoryStageWorkflowBinding = {
    createBatch: async (batch) => {
      calls.createBatch.push(batch);
      return created ? [instance] : [];
    },
    get: async (id) => {
      calls.get.push(id);
      return instance;
    },
  };
  return { calls, workflow };
}

describe('startFactoryStageWorkflowWithBinding', () => {
  it('creates a missing stage workflow with the durable stage id and exact queue payload', async () => {
    const { calls, workflow } = fakeWorkflow('queued', true);

    await startFactoryStageWorkflowWithBinding(workflow, message);

    expect(calls.createBatch).toEqual([[{ id: 'factory-stage-73', params: message }]]);
    expect(calls.get).toEqual([]);
    expect(calls.restart).toBe(0);
  });

  it('leaves an existing active workflow alone after idempotent creation skips it', async () => {
    const { calls, workflow } = fakeWorkflow('running', false);

    await startFactoryStageWorkflowWithBinding(workflow, message);

    expect(calls.get).toEqual(['factory-stage-73']);
    expect(calls.restart).toBe(0);
  });

  it.each(['errored', 'terminated'] as const)(
    'restarts an existing %s workflow so recovery can make progress',
    async (status) => {
      const { calls, workflow } = fakeWorkflow(status, false);

      await startFactoryStageWorkflowWithBinding(workflow, message);

      expect(calls.get).toEqual(['factory-stage-73']);
      expect(calls.restart).toBe(1);
    },
  );
});
