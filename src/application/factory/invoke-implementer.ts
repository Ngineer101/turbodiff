import type { SkillRow } from '../../data/skills.ts';
import { isJsonObject, isString } from '../../shared/json.ts';
import type { ZodType } from 'zod';
import type { RepositoryChangeArtifact } from '../../artifacts/change.ts';
import type { AgentRow } from '../../data/agents.ts';
import type { RepositoryRow } from '../../data/repositories.ts';
import { runCodingAgent } from '../../integrations/agent-runtime/coding-agent.ts';
import { readRepositoryChangeArtifact } from '../../integrations/agent-runtime/repository-change-artifact.ts';
import { redactSecrets } from '../../integrations/agent-runtime/redaction.ts';
import { generationSandbox } from '../../integrations/agent-runtime/sandbox.ts';
import { NPM_CACHE_ENV } from '../../integrations/agent-runtime/sandbox-deps.ts';
import type { buildSandboxMcpConfig } from '../integrations/mcp-proxy.ts';
import type { AgentInvocation, TrackedAgentExecutionRequest } from './agent-run.ts';
import { resolveRunnerAuth } from './runner-auth.ts';

const AGENT_TIMEOUT_MS = 25 * 60_000;

export async function invokeImplementer(
  agent: AgentRow,
  repository: RepositoryRow,
  workDir: string,
  promptFile: string,
  summaryFile: string,
  notesFile: string,
  request: TrackedAgentExecutionRequest,
  output: ZodType<RepositoryChangeArtifact>,
  mcp: Awaited<ReturnType<typeof buildSandboxMcpConfig>>,
  secrets: string[] = [],
  fallbackSummary = `${repository.owner}/${repository.name} implementation`,
): Promise<AgentInvocation<RepositoryChangeArtifact>> {
  if (request.repositoryAccess !== 'write') throw new Error('implementer must have write access');
  const auth = await resolveRunnerAuth(request.model, request.usage);
  const sanitize = (value: string) =>
    redactSecrets(value, [...Object.values(auth.vars), ...(mcp?.secrets ?? []), ...secrets]);
  const override = agent.instructions_override?.trim();
  await generationSandbox(repository).writeFile(
    promptFile,
    `${request.prompt}${override ? `\n\n## Organization instructions\n${override}` : ''}`,
  );
  const run = await runCodingAgent(generationSandbox(repository), auth, {
    promptFile,
    cwd: workDir,
    timeout: AGENT_TIMEOUT_MS,
    env: NPM_CACHE_ENV,
    configExtensionJson: mcp?.configJson,
  });
  if (!run.success) {
    throw new Error(
      `implementation agent exited ${run.exitCode}: ${sanitize(`${run.resultText}\n${run.stderr}`).slice(-1_000)}`,
    );
  }
  return {
    artifact: await readRepositoryChangeArtifact(
      generationSandbox(repository),
      workDir,
      output,
      {
        summary: summaryFile,
        notes: notesFile,
      },
      fallbackSummary,
    ),
    run,
    sanitize,
  };
}

export function runtimeSkills(rows: SkillRow[]) {
  return [...new Map(rows.map((row) => [row.id, row])).values()].map((row) => ({
    slug: row.slug,
    name: row.name,
    description: null,
    instructions: row.content,
  }));
}

interface DeliveryRepositorySettings {
  checkCommand: string | null;
}

export function repositorySettings(repository: RepositoryRow): DeliveryRepositorySettings {
  if (!isJsonObject(repository.settings)) return { checkCommand: null };
  return {
    checkCommand:
      isString(repository.settings.checkCommand) && repository.settings.checkCommand.trim()
        ? repository.settings.checkCommand.trim()
        : null,
  };
}
