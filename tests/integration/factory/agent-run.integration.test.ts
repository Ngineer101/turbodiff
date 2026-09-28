import { z } from 'zod';
import { describe, expect, it } from 'vite-plus/test';
import { defineAgent } from '../../../src/agents/types.ts';
import { loadArtifactBody } from '../../../src/application/artifacts.ts';
import { runTrackedAgent } from '../../../src/application/factory/agent-run.ts';
import { getAgent } from '../../../src/data/agents.ts';
import { getArtifact } from '../../../src/data/artifacts.ts';
import { createFactoryRunWithStage, listAgentRunsForStage } from '../../../src/data/execution.ts';
import { createWorkItem } from '../../../src/data/work.ts';
import {
  CodingAgentRunFailure,
  type CodingAgentRun,
} from '../../../src/integrations/agent-runtime/coding-agent.ts';
import { createTenant, rollbackAfter } from '../api/support.ts';

const trackedDefinition = defineAgent({
  id: 'planner',
  repositoryAccess: 'read',
  input: z.object({ operation: z.literal('test') }).strict(),
  output: () => z.object({ accepted: z.literal(true) }).strict(),
  prompt: () => 'Produce a test artifact.',
});

function completedRun(): CodingAgentRun {
  return {
    success: true,
    exitCode: 0,
    stdout: 'initial stdout\ncorrection stdout',
    stderr: 'secret stderr',
    command: 'opencode run',
    duration: 2,
    timestamp: new Date().toISOString(),
    resultText: 'initial result\n\ncorrection result',
    codingSessionId: 'ses_failedoutput1',
    usage: {
      inputTokens: 130,
      outputTokens: 30,
      cacheReadTokens: 11,
      cacheWriteTokens: 7,
      model: 'openai/test',
    },
  };
}

describe('tracked agent failures', () => {
  it('persists usage and logs when paid calls complete before output validation fails', () =>
    rollbackAfter(async () => {
      const tenant = await createTenant();
      const agent = await getAgent(tenant.agentId);
      if (!agent) throw new Error('agent fixture is missing');
      const workItem = await createWorkItem({
        organizationId: tenant.organizationId,
        title: 'Failed output accounting',
        description: 'Preserve completed model usage when validation fails.',
        origin: 'idea',
        repositoryIds: [tenant.repositoryId],
      });
      const { factoryRun, stageRun } = await createFactoryRunWithStage(
        {
          organizationId: tenant.organizationId,
          flowKey: 'work_item',
          flowVersion: 1,
          workItemId: workItem.id,
          trigger: 'test',
          idempotencyKey: crypto.randomUUID(),
        },
        { stageKey: 'plan', idempotencyKey: crypto.randomUUID() },
      );

      await expect(
        runTrackedAgent({
          factoryRun,
          stageRun,
          agent,
          definition: trackedDefinition,
          value: { operation: 'test' as const },
          inputKind: 'test_input',
          outputKind: 'test_output',
          invoke: async () => {
            throw new CodingAgentRunFailure(
              'corrected planner artifact is invalid',
              completedRun(),
              (value) => value.replaceAll('secret', '[REDACTED]'),
            );
          },
        }),
      ).rejects.toThrow('corrected planner artifact is invalid');

      const [persisted] = await listAgentRunsForStage(stageRun.id);
      expect(persisted).toMatchObject({
        status: 'failed',
        input_tokens: 130,
        output_tokens: 30,
        cache_read_tokens: 11,
        cache_write_tokens: 7,
        error_code: 'agent_failed',
        error_message: 'corrected planner artifact is invalid',
        log_artifact_id: expect.any(Number),
      });
      const log = persisted?.log_artifact_id ? await getArtifact(persisted.log_artifact_id) : null;
      expect(log).not.toBeNull();
      if (!log) throw new Error('failed agent log was not persisted');
      expect(await loadArtifactBody(log)).toBe(
        'initial result\n\ncorrection result\n[REDACTED] stderr',
      );
    }));
});
