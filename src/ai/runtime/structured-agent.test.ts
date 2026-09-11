import { describe, expect, it } from 'vite-plus/test';
import { z } from 'zod';
import { structuredAgentPrompt } from './structured-agent.ts';

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
});
