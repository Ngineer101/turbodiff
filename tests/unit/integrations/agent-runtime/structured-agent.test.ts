import { describe, expect, it } from 'vite-plus/test';
import { z } from 'zod';
import {
  runStructuredAgent,
  structuredAgentPrompt,
} from '../../../../src/integrations/agent-runtime/structured-agent.ts';

const request = {
  agentId: 'example',
  model: 'anthropic/example',
  prompt: 'Do the work.',
  repositoryAccess: 'read' as const,
};

describe('structured agent runtime', () => {
  it('derives the artifact instructions from the supplied Zod schema', () => {
    const prompt = structuredAgentPrompt(
      request,
      z.object({ answer: z.string(), count: z.number().int() }).strict(),
      '/workspace/artifact.json',
      'The repository is checked out at the requested revision.',
    );

    expect(prompt).toContain('Do the work.');
    expect(prompt).toContain('/workspace/artifact.json');
    expect(prompt).toContain('The repository is checked out at the requested revision.');
    expect(prompt).toContain('"additionalProperties": false');
    expect(prompt).toContain('"answer"');
  });

  it('preserves a deployment interruption while reading the final artifact', async () => {
    const interrupted = new Error(
      'Sandbox operation sandbox.readFile was interrupted while the platform was updating the sandbox runtime',
    );
    const sandbox = {
      async exec(command: string) {
        return {
          success: true,
          exitCode: 0,
          stdout: '',
          stderr: '',
          command,
          duration: 1,
          timestamp: new Date().toISOString(),
        };
      },
      async writeFile() {
        return { success: true };
      },
      async readFile() {
        throw interrupted;
      },
    };

    await expect(
      runStructuredAgent({
        sandbox,
        auth: { baseURL: 'https://gateway.test', vars: {}, model: 'anthropic/example' },
        request,
        output: z.object({ answer: z.string() }),
        cwd: '/workspace',
        promptFile: '/workspace/prompt.md',
        artifactFile: '/workspace/artifact.json',
        timeout: 1_000,
      }),
    ).rejects.toBe(interrupted);
  });
});
