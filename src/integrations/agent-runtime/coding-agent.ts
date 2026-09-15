import type { ExecOptions, ExecResult } from '@cloudflare/sandbox';
import type { CliUsage } from '../../shared/usage.ts';
import { runnerEnvironment, type RunnerAuth } from './runner-config.ts';
import {
  codingAgentResultText,
  codingAgentSessionId,
  parseCodingAgentUsage,
} from './coding-agent-output.ts';

export type { CliUsage } from '../../shared/usage.ts';
export { addCliUsage } from './coding-agent-output.ts';

export interface CodingAgentSandbox {
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
}

export interface CodingAgentRun extends ExecResult {
  resultText: string;
  codingSessionId: string | null;
  usage: CliUsage | null;
}

interface RunCodingAgentOptions {
  promptFile: string;
  cwd: string;
  timeout: number;
  sessionId?: string | null;
  env?: Record<string, string>;
  configExtensionJson?: string;
}

export async function runCodingAgent(
  sandbox: CodingAgentSandbox,
  auth: RunnerAuth,
  options: RunCodingAgentOptions,
): Promise<CodingAgentRun> {
  const resume = options.sessionId ? ' --session "$TURBODIFF_AGENT_SESSION"' : '';
  const agentEnv = options.sessionId
    ? {
        ...options.env,
        TURBODIFF_AGENT_PROMPT: options.promptFile,
        TURBODIFF_AGENT_SESSION: options.sessionId,
      }
    : { ...options.env, TURBODIFF_AGENT_PROMPT: options.promptFile };
  const result = await sandbox.exec(
    'opencode run --pure --auto --format json --model "$TURBODIFF_RUNNER_MODEL"' +
      `${resume} < "$TURBODIFF_AGENT_PROMPT"`,
    {
      cwd: options.cwd,
      timeout: options.timeout,
      env: runnerEnvironment(auth, agentEnv, options.configExtensionJson),
    },
  );
  return {
    ...result,
    resultText: codingAgentResultText(result.stdout),
    codingSessionId: codingAgentSessionId(result.stdout),
    usage: parseCodingAgentUsage(result.stdout, auth.model),
  };
}
