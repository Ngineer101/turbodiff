import type { Sandbox } from '@cloudflare/sandbox';
import { z, type ZodType } from 'zod';
import type { AgentExecutionRequest } from '../../agents/types.ts';
import { runCodingAgent, type CodingAgentRun } from './coding-agent.ts';
import type { RunnerAuth } from './runner-auth.ts';

export interface StructuredAgentOptions<Output> {
  sandbox: Sandbox;
  auth: RunnerAuth;
  request: AgentExecutionRequest;
  output: ZodType<Output>;
  cwd: string;
  promptFile: string;
  artifactFile: string;
  timeout: number;
  runtimeContext?: string;
  configExtensionJson?: string;
  sanitize?: (value: string) => string;
  onComplete?: (run: CodingAgentRun) => Promise<void>;
}

export function structuredAgentPrompt<Output>(
  request: AgentExecutionRequest,
  output: ZodType<Output>,
  artifactFile: string,
  runtimeContext?: string,
): string {
  const context = runtimeContext?.trim();
  return `${request.prompt}

${context ? `## Runtime context\n${context}\n\n` : ''}## Output contract
Write the final artifact as JSON to ${artifactFile}. Do not wrap it in markdown and do not use your final prose response as the artifact.

The JSON must match this schema exactly:
${JSON.stringify(z.toJSONSchema(output), null, 2)}
`;
}

export async function runStructuredAgent<Output>(
  options: StructuredAgentOptions<Output>,
): Promise<{ artifact: Output; run: CodingAgentRun }> {
  await options.sandbox.exec(`rm -f ${options.artifactFile}`);
  await options.sandbox.writeFile(
    options.promptFile,
    structuredAgentPrompt(
      options.request,
      options.output,
      options.artifactFile,
      options.runtimeContext,
    ),
  );
  const run = await runCodingAgent(options.sandbox, options.auth, {
    promptFile: options.promptFile,
    cwd: options.cwd,
    timeout: options.timeout,
    configExtensionJson: options.configExtensionJson,
  });
  await options.onComplete?.(run);
  if (!run.success) {
    const detail = `${run.resultText}\n${run.stderr}`.trim().slice(-1_000);
    throw new Error(`agent exited ${run.exitCode}: ${options.sanitize?.(detail) ?? detail}`);
  }

  let raw: string;
  try {
    raw = (await options.sandbox.readFile(options.artifactFile)).content;
  } catch {
    throw new Error(`agent did not produce ${options.artifactFile}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`agent produced invalid JSON in ${options.artifactFile}`);
  }
  return { artifact: options.output.parse(parsed), run };
}
