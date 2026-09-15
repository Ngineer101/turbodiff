import type { Sandbox } from '@cloudflare/sandbox';
import type { ZodType } from 'zod';
import {
  plannerAgent,
  PLANNER_OUTPUT_DIR,
  type PlannerArtifact,
  type PlannerDraftInput,
} from '../../../agents/planner.ts';
import type { AgentExecutionRequest } from '../../../agents/types.ts';
import { runCodingAgent } from '../../../ai/runtime/coding-agent.ts';
import { PLANNING_CONFIG } from '../../../ai/runtime/planning-session.ts';
import { redactSecrets } from '../../../ai/runtime/redaction.ts';
import { resolveRunnerAuth } from '../../../ai/runtime/runner-auth.ts';
import { runnerSandbox } from '../../../ai/runtime/sandbox.ts';
import { mountSkills } from '../../../ai/runtime/skills.ts';
import {
  getAgentBySlug,
  getAgent,
  getRepository,
  getWorkItem,
  listSkillsForAgent,
  listSkillsForAutomation,
  listSkillsForRepository,
  listAutomationIntegrations,
  listRepositoryIntegrations,
  listWorkItemTargets,
  updateWorkItem,
  type AgentRow,
  type FactoryRunRow,
  type SkillRow,
  type StageRunRow,
} from '../../../data/db.ts';
import { ensureBuiltinAgents } from '../../../data/agents.ts';
import { remoteSourceOf, resolveWorkspaceRemote } from '../../../integrations/git/provider.ts';
import { buildSandboxMcpConfig, type SandboxMcpBinding } from '../../../integrations/mcp/proxy.ts';
import { runTrackedAgent, type AgentInvocation } from '../agent-run.ts';

const PROMPT_FILE = `${PLANNER_OUTPUT_DIR}/task.md`;
const AGENT_TIMEOUT_MS = 25 * 60_000;

function runtimeSkills(rows: SkillRow[]) {
  return [...new Map(rows.map((row) => [row.id, row])).values()].map((row) => ({
    slug: row.slug,
    name: row.name,
    description: null,
    instructions: row.content,
  }));
}

async function requiredText(sandbox: Sandbox, path: string): Promise<string> {
  const value = (await sandbox.readFile(path)).content.trim();
  if (!value) throw new Error(`planner did not produce ${path}`);
  return value;
}

async function optionalText(sandbox: Sandbox, path: string): Promise<string | null> {
  try {
    return (await sandbox.readFile(path)).content.trim() || null;
  } catch {
    return null;
  }
}

async function invokePlanner(
  sandbox: Sandbox,
  agent: AgentRow,
  secrets: string[],
  request: AgentExecutionRequest,
  output: ZodType<PlannerArtifact>,
  configExtensionJson?: string,
): Promise<AgentInvocation<PlannerArtifact>> {
  if (request.repositoryAccess !== 'read') throw new Error('planner must be read-only');
  const auth = await resolveRunnerAuth(request.model);
  const sanitize = (value: string) =>
    redactSecrets(value, [...secrets, ...Object.values(auth.vars)]);
  await sandbox.exec(`rm -rf ${PLANNER_OUTPUT_DIR} && mkdir -p ${PLANNER_OUTPUT_DIR}`);
  const override = agent.instructions_override?.trim();
  await sandbox.writeFile(
    PROMPT_FILE,
    `${request.prompt}${override ? `\n\n## Organization instructions\n${override}` : ''}`,
  );
  const run = await runCodingAgent(sandbox, auth, {
    promptFile: PROMPT_FILE,
    cwd: '/workspace',
    timeout: AGENT_TIMEOUT_MS,
    configExtensionJson: configExtensionJson ?? PLANNING_CONFIG,
  });
  if (!run.success) {
    throw new Error(
      `planning agent exited ${run.exitCode}: ${sanitize(`${run.resultText}\n${run.stderr}`).slice(-1_000)}`,
    );
  }
  const artifact = output.parse({
    kind: 'plan',
    plan: await requiredText(sandbox, `${PLANNER_OUTPUT_DIR}/plan.md`),
    summary: await optionalText(sandbox, `${PLANNER_OUTPUT_DIR}/summary.md`),
    acceptance: JSON.parse(await requiredText(sandbox, `${PLANNER_OUTPUT_DIR}/acceptance.json`)),
  });
  return { artifact, run, sanitize };
}

export async function executePlanningStage(
  factoryRun: FactoryRunRow,
  stageRun: StageRunRow,
  selectedAgentId?: number,
): Promise<{ artifactId: number }> {
  if (!factoryRun.work_item_id) throw new Error('planning run has no work item');
  const workItem = await getWorkItem(factoryRun.work_item_id);
  if (!workItem || workItem.organization_id !== factoryRun.organization_id) {
    throw new Error('planning work item is missing');
  }
  const targets = await listWorkItemTargets([workItem.id]);
  if (targets.length === 0) throw new Error('planning work item has no repository targets');

  await ensureBuiltinAgents(factoryRun.organization_id);
  const agent = selectedAgentId
    ? await getAgent(selectedAgentId)
    : await getAgentBySlug(factoryRun.organization_id, 'planner');
  if (
    !agent?.enabled ||
    agent.organization_id !== factoryRun.organization_id ||
    agent.definition_key !== plannerAgent.id
  ) {
    throw new Error('planner agent is unavailable');
  }

  const sandbox = runnerSandbox(`plan--${factoryRun.id}`, { sleepAfter: '10m' });
  const workspaceRoot = `/workspace/planning-${factoryRun.id}`;
  await sandbox.exec(`rm -rf ${workspaceRoot} && mkdir -p ${workspaceRoot}`);
  const repositories: PlannerDraftInput['repositories'] = [];
  const secrets: string[] = [];
  const mcpBindings: SandboxMcpBinding[] = [];
  try {
    for (const target of targets) {
      const repository = await getRepository(target.repository_id);
      if (!repository?.enabled || repository.organization_id !== factoryRun.organization_id) {
        throw new Error(`repository ${target.repository_id} is missing or disabled`);
      }
      const remote = await resolveWorkspaceRemote(remoteSourceOf(repository), 'read');
      secrets.push(remote.token);
      const path = `${workspaceRoot}/repository-${repository.id}`;
      const base = repository.default_branch ?? 'main';
      const cloned = await sandbox.exec(
        `git ${remote.configFlags} clone --depth 50 --single-branch --branch "$BASE_REF" ` +
          `"${remote.authUrl}" ${path}`,
        { env: { ...remote.env, BASE_REF: base }, timeout: 5 * 60_000 },
      );
      if (!cloned.success) {
        throw new Error(
          `git clone failed for ${repository.owner}/${repository.name}: ` +
            redactSecrets(cloned.stderr, [remote.token]).slice(-500),
        );
      }
      await sandbox.exec(`git -C ${path} remote set-url origin "${remote.cleanUrl}"`);
      const skills = await Promise.all([
        listSkillsForRepository(repository.id),
        listSkillsForAgent(agent.id),
        ...(factoryRun.automation_id ? [listSkillsForAutomation(factoryRun.automation_id)] : []),
      ]);
      await mountSkills(sandbox, path, runtimeSkills(skills.flat()));
      const integrations = await listRepositoryIntegrations(repository.id);
      mcpBindings.push(
        ...integrations.map((integration) => ({ integration, repositoryId: repository.id })),
      );
      repositories.push({ fullName: `${repository.owner}/${repository.name}`, path });
    }

    if (factoryRun.automation_id) {
      const repositoryId = targets[0]!.repository_id;
      const integrations = await listAutomationIntegrations(factoryRun.automation_id);
      mcpBindings.push(
        ...integrations.map((integration) => ({
          integration,
          repositoryId,
          automationId: factoryRun.automation_id!,
        })),
      );
    }
    const mcp = await buildSandboxMcpConfig(mcpBindings);
    secrets.push(...(mcp?.secrets ?? []));

    const plannerInput: PlannerDraftInput = {
      operation: 'draft',
      title: workItem.title,
      requirements: workItem.description,
      repositories,
      attachments: [],
      analysis: null,
      tier: 'standard',
      answers: [],
      feedback: [],
      previousPlan: null,
      previousSummary: null,
    };
    const tracked = await runTrackedAgent({
      factoryRun,
      stageRun,
      agent,
      definition: plannerAgent,
      value: plannerInput,
      inputKind: 'planner_input',
      outputKind: 'plan',
      invoke: (request, output) =>
        invokePlanner(
          sandbox,
          agent,
          secrets,
          request,
          output,
          mcp
            ? JSON.stringify({
                ...JSON.parse(PLANNING_CONFIG),
                ...JSON.parse(mcp.configJson),
              })
            : PLANNING_CONFIG,
        ),
    });
    if (tracked.artifact.kind !== 'plan') throw new Error('planner returned an analysis artifact');
    await updateWorkItem(workItem.id, { status: 'awaiting_approval' });
    return { artifactId: tracked.outputArtifactId };
  } finally {
    await sandbox.exec(`rm -rf ${workspaceRoot} ${PLANNER_OUTPUT_DIR}`).catch(() => undefined);
  }
}
