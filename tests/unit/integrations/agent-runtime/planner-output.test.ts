import { describe, expect, it } from 'vite-plus/test';
import { planArtifactSchema } from '../../../../src/artifacts/plan.ts';
import {
  CodingAgentRunFailure,
  type CodingAgentRun,
} from '../../../../src/integrations/agent-runtime/coding-agent.ts';
import { readPlannerOutputWithCorrection } from '../../../../src/integrations/agent-runtime/planner-output.ts';

const directory = '/workspace/plan-out';

function codingRun(
  name: string,
  options: { sessionId?: string | null; inputTokens?: number; outputTokens?: number } = {},
): CodingAgentRun {
  return {
    success: true,
    exitCode: 0,
    stdout: `${name} stdout`,
    stderr: '',
    command: 'opencode run',
    duration: 1,
    timestamp: new Date().toISOString(),
    resultText: `${name} result`,
    codingSessionId: options.sessionId ?? null,
    usage: {
      inputTokens: options.inputTokens ?? 10,
      outputTokens: options.outputTokens ?? 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      model: 'openai/test',
    },
  };
}

function outputSandbox(files: Map<string, string>) {
  return {
    async readFile(path: string) {
      const content = files.get(path);
      if (content === undefined) throw new Error(`missing ${path}`);
      return { content };
    },
  };
}

function validFiles() {
  return new Map([
    [`${directory}/plan.md`, 'Update the model catalog.'],
    [`${directory}/summary.md`, 'Adds the new model option.'],
    [`${directory}/acceptance.json`, '["The model appears in the picker."]'],
  ]);
}

describe('planner output correction', () => {
  it('accepts valid files without spending a correction attempt', async () => {
    let corrections = 0;
    const initialRun = codingRun('initial', { sessionId: 'ses_validoutput1' });
    const result = await readPlannerOutputWithCorrection({
      sandbox: outputSandbox(validFiles()),
      output: planArtifactSchema('standard'),
      directory,
      tier: 'standard',
      initialRun,
      correct: async () => {
        corrections += 1;
        return codingRun('unexpected');
      },
    });

    expect(result.artifact.acceptance).toEqual(['The model appears in the picker.']);
    expect(result.run).toBe(initialRun);
    expect(corrections).toBe(0);
  });

  it('repairs object-shaped acceptance output once and preserves both runs usage', async () => {
    const files = validFiles();
    files.set(`${directory}/acceptance.json`, '[{"criterion":"The model appears in the picker."}]');
    let corrections = 0;
    const result = await readPlannerOutputWithCorrection({
      sandbox: outputSandbox(files),
      output: planArtifactSchema('standard'),
      directory,
      tier: 'standard',
      initialRun: codingRun('initial', {
        sessionId: 'ses_invalidoutput1',
        inputTokens: 100,
        outputTokens: 20,
      }),
      correct: async (prompt, sessionId) => {
        corrections += 1;
        expect(sessionId).toBe('ses_invalidoutput1');
        expect(prompt).toContain('Every array item MUST be a plain JSON string');
        expect(prompt).toContain('expected string, received object');
        files.set(`${directory}/acceptance.json`, '["The model appears in the picker."]');
        return codingRun('correction', {
          sessionId: 'ses_invalidoutput1',
          inputTokens: 30,
          outputTokens: 10,
        });
      },
    });

    expect(result.artifact.acceptance).toEqual(['The model appears in the picker.']);
    expect(result.run.usage).toMatchObject({ inputTokens: 130, outputTokens: 30 });
    expect(result.run.stdout).toContain('initial stdout');
    expect(result.run.stdout).toContain('correction stdout');
    expect(corrections).toBe(1);
  });

  it('repairs a missing required output file once', async () => {
    const files = validFiles();
    files.delete(`${directory}/acceptance.json`);
    let corrections = 0;

    const result = await readPlannerOutputWithCorrection({
      sandbox: outputSandbox(files),
      output: planArtifactSchema('standard'),
      directory,
      tier: 'standard',
      initialRun: codingRun('initial', { sessionId: 'ses_missingoutput1' }),
      correct: async (prompt, sessionId) => {
        corrections += 1;
        expect(sessionId).toBe('ses_missingoutput1');
        expect(prompt).toContain(`missing ${directory}/acceptance.json`);
        files.set(`${directory}/acceptance.json`, '["The model appears in the picker."]');
        return codingRun('correction', { sessionId: 'ses_missingoutput1' });
      },
    });

    expect(result.artifact.acceptance).toEqual(['The model appears in the picker.']);
    expect(corrections).toBe(1);
  });

  it('stops after one correction when output remains malformed', async () => {
    const files = validFiles();
    files.set(`${directory}/acceptance.json`, '{not valid json');
    let corrections = 0;
    let failure: unknown;

    try {
      await readPlannerOutputWithCorrection({
        sandbox: outputSandbox(files),
        output: planArtifactSchema('standard'),
        directory,
        tier: 'standard',
        initialRun: codingRun('initial', { inputTokens: 100, outputTokens: 20 }),
        correct: async () => {
          corrections += 1;
          return codingRun('correction', { inputTokens: 30, outputTokens: 10 });
        },
      });
    } catch (caught) {
      failure = caught;
    }

    expect(failure).toBeInstanceOf(CodingAgentRunFailure);
    if (!(failure instanceof CodingAgentRunFailure)) throw failure;
    expect(failure.run.usage).toMatchObject({ inputTokens: 130, outputTokens: 30 });
    expect(failure.run.resultText).toContain('initial result');
    expect(failure.run.resultText).toContain('correction result');
    expect(corrections).toBe(1);
  });

  it('returns deployment interruptions to Workflow without asking the model to correct output', async () => {
    const interrupted = {
      code: 'OPERATION_INTERRUPTED',
      context: { reason: 'runtime_replaced', retryable: false },
    };
    let corrections = 0;

    await expect(
      readPlannerOutputWithCorrection({
        sandbox: {
          async readFile() {
            throw interrupted;
          },
        },
        output: planArtifactSchema('standard'),
        directory,
        tier: 'standard',
        initialRun: codingRun('initial'),
        correct: async () => {
          corrections += 1;
          return codingRun('correction');
        },
      }),
    ).rejects.toBe(interrupted);
    expect(corrections).toBe(0);
  });
});
