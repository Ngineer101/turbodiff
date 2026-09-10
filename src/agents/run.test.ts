import { describe, expect, it } from 'vite-plus/test';
import { z } from 'zod';
import { runAgent } from './run.ts';
import { defineAgent, type AgentExecutionRequest, type AgentExecutor } from './types.ts';

const inputSchema = z.object({ task: z.string().trim().min(1) }).strict();
const outputSchema = z.object({ artifact: z.string().trim().min(1) }).strict();

const testAgent = defineAgent<{ task: string }, { artifact: string }>({
  id: 'test-agent',
  repositoryAccess: 'read',
  input: inputSchema,
  output: () => outputSchema,
  prompt: (input) => `Do ${input.task}`,
});

describe('runAgent', () => {
  it('validates input before invoking the paid executor', async () => {
    let executed = false;
    const execute: AgentExecutor = async () => {
      executed = true;
      throw new Error('executor should not run');
    };

    await expect(
      runAgent(testAgent, { task: '' }, { model: 'provider/model', execute }),
    ).rejects.toThrow();
    expect(executed).toBe(false);
  });

  it('passes execution metadata and requires the executor to validate its artifact', async () => {
    const requests: AgentExecutionRequest[] = [];
    let rawArtifact = { artifact: 'finished' };
    const execute: AgentExecutor = async (request, artifactSchema) => {
      requests.push(request);
      return artifactSchema.parse(rawArtifact);
    };

    await expect(
      runAgent(testAgent, { task: 'the work' }, { model: 'provider/model', execute }),
    ).resolves.toEqual({ artifact: 'finished' });
    expect(requests).toEqual([
      {
        agentId: 'test-agent',
        model: 'provider/model',
        prompt: 'Do the work',
        repositoryAccess: 'read',
      },
    ]);

    rawArtifact = { artifact: '' };
    await expect(
      runAgent(testAgent, { task: 'the work' }, { model: 'provider/model', execute }),
    ).rejects.toThrow();
  });
});
