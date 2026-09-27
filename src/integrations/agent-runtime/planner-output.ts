import type { ZodType } from 'zod';
import type { PlanningTier } from '../../artifacts/plan.ts';
import { addCliUsage, type CodingAgentRun } from './coding-agent.ts';
import { retrySandboxOperation, sandboxRetryDisposition } from './sandbox-retry.ts';

export interface PlannerOutputSandbox {
  readFile(path: string): Promise<{ content: string }>;
}

interface PlannerOutputFiles {
  directory: string;
  tier: PlanningTier;
}

async function requiredText(sandbox: PlannerOutputSandbox, path: string): Promise<string> {
  const value = (await retrySandboxOperation(() => sandbox.readFile(path))).content.trim();
  if (!value) throw new Error(`planner did not produce ${path}`);
  return value;
}

async function optionalText(sandbox: PlannerOutputSandbox, path: string): Promise<string | null> {
  try {
    return (await retrySandboxOperation(() => sandbox.readFile(path))).content.trim() || null;
  } catch (failure) {
    if (sandboxRetryDisposition(failure) !== 'none') throw failure;
    return null;
  }
}

async function readPlannerOutput<Output>(
  sandbox: PlannerOutputSandbox,
  output: ZodType<Output>,
  files: PlannerOutputFiles,
): Promise<Output> {
  return output.parse({
    kind: 'plan',
    plan: await requiredText(sandbox, `${files.directory}/plan.md`),
    summary: await optionalText(sandbox, `${files.directory}/summary.md`),
    acceptance: JSON.parse(await requiredText(sandbox, `${files.directory}/acceptance.json`)),
  });
}

function correctionPrompt<Failure>(files: PlannerOutputFiles, failure: Failure): string {
  const limit = files.tier === 'trivial' ? 4 : 8;
  const detail = failure instanceof Error ? failure.message : 'Planner output was invalid';
  return `Your output files failed validation. Do not repeat the research or change the plan's scope. Rewrite only the invalid or missing files in ${files.directory} so they satisfy this exact contract:

- plan.md: non-empty Markdown implementation plan.
- acceptance.json: valid JSON containing an array of at most ${limit} non-empty strings. Every array item MUST be a plain JSON string, never an object or array. Example: ["The model picker lists Opus 5.5.", "Selecting Opus 5.5 sends the configured gateway model ID."]
${files.tier === 'standard' ? '- summary.md: non-empty reviewer-facing Markdown summary.' : '- summary.md: optional reviewer-facing Markdown summary.'}

Validation failure:
${detail.slice(0, 4_000)}

After correcting the files, stop.`;
}

function combineRuns(initial: CodingAgentRun, correction: CodingAgentRun): CodingAgentRun {
  return {
    ...correction,
    stdout: [initial.stdout, correction.stdout].filter(Boolean).join('\n'),
    stderr: [initial.stderr, correction.stderr].filter(Boolean).join('\n'),
    resultText: [initial.resultText, correction.resultText].filter(Boolean).join('\n\n'),
    codingSessionId: correction.codingSessionId ?? initial.codingSessionId,
    usage: addCliUsage(initial.usage, correction.usage),
  };
}

/** Validate planner files, allowing exactly one model correction for malformed output. */
export async function readPlannerOutputWithCorrection<Output>(input: {
  sandbox: PlannerOutputSandbox;
  output: ZodType<Output>;
  directory: string;
  tier: PlanningTier;
  initialRun: CodingAgentRun;
  correct: (prompt: string, sessionId: string | null) => Promise<CodingAgentRun>;
}): Promise<{ artifact: Output; run: CodingAgentRun }> {
  const files = { directory: input.directory, tier: input.tier };
  try {
    return {
      artifact: await readPlannerOutput(input.sandbox, input.output, files),
      run: input.initialRun,
    };
  } catch (failure) {
    if (sandboxRetryDisposition(failure) !== 'none') throw failure;
    const correction = await input.correct(
      correctionPrompt(files, failure),
      input.initialRun.codingSessionId,
    );
    return {
      artifact: await readPlannerOutput(input.sandbox, input.output, files),
      run: combineRuns(input.initialRun, correction),
    };
  }
}
