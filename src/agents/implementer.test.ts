import { describe, expect, it } from 'vite-plus/test';
import { implementerAgent, type ImplementInput, type ImplementRepairInput } from './implementer.ts';

const outputFiles = {
  summary: '/workspace/summary.md',
  notes: '/workspace/notes.md',
};

function implementation(overrides: Partial<ImplementInput> = {}): ImplementInput {
  return {
    operation: 'implement',
    repository: 'acme/app',
    title: 'Show running tasks',
    instructions: 'Include manual tasks in the running indicator.',
    scope: 'standard',
    testing: 'repository-patterns',
    noChangeOutcome: 'unexpected',
    check: { kind: 'gated', command: 'vp check' },
    outputFiles,
    ...overrides,
  };
}

describe('implementer agent', () => {
  it('is a generic write-capable agent with explicit output files', () => {
    const input = implementerAgent.input.parse(implementation());
    const prompt = implementerAgent.prompt(input);

    expect(implementerAgent.repositoryAccess).toBe('write');
    expect(prompt).toContain('fresh checkout of acme/app');
    expect(prompt).toContain('run `vp check`');
    expect(prompt).toContain(outputFiles.summary);
    expect(prompt).toContain(outputFiles.notes);
  });

  it('keeps baseline failures outside the implementation scope', () => {
    const input = implementerAgent.input.parse(
      implementation({ check: { kind: 'baseline-failed', command: 'vp check' } }),
    );

    expect(implementerAgent.prompt(input)).toContain(
      'Do not try to fix those pre-existing failures',
    );
  });

  it('supports a bounded repair turn without changing the artifact type', () => {
    const repair: ImplementRepairInput = {
      operation: 'repair',
      checkCommand: 'vp check',
      checkOutput: 'Type error in src/task.ts',
      freshSession: true,
      originalTaskFile: '/workspace/task.md',
      outputFiles,
    };
    const input = implementerAgent.input.parse(repair);
    const prompt = implementerAgent.prompt(input);

    expect(prompt).toContain('Read /workspace/task.md');
    expect(prompt).toContain('Type error in src/task.ts');
    expect(implementerAgent.output(input)).toBe(implementerAgent.output(implementation()));
  });

  it('accepts a failed check with no output and explains it to the agent', () => {
    const input = implementerAgent.input.parse({
      operation: 'repair',
      checkCommand: 'vp check',
      checkOutput: '',
      freshSession: false,
      originalTaskFile: '/workspace/task.md',
      outputFiles,
    });

    expect(implementerAgent.prompt(input)).toContain(
      'command exited unsuccessfully without output',
    );
  });
});
