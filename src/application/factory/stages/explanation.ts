import type { Sandbox } from '@cloudflare/sandbox';
import type { ZodType } from 'zod';
import { explainerAgent, type ExplainerInput } from '../../../agents/explainer.ts';
import type { ExplanationArtifact } from '../../../artifacts/explanation.ts';
import { changeRevisionArtifactSchema } from '../../../artifacts/change.ts';
import { redactSecrets } from '../../../integrations/agent-runtime/redaction.ts';
import { resolveRunnerAuth } from '../runner-auth.ts';
import { runnerSandbox } from '../../../integrations/agent-runtime/sandbox.ts';
import { runStructuredAgent } from '../../../integrations/agent-runtime/structured-agent.ts';
import { ensureBuiltinAgents, getAgentBySlug } from '../../../data/agents.ts';
import { getArtifact } from '../../../data/artifacts.ts';
import { getChange, latestChangeRevision } from '../../../data/changes.ts';
import type { FactoryRunRow, StageRunRow } from '../../../data/execution.ts';
import { loadJsonArtifact } from '../../artifacts.ts';
import {
  runTrackedAgent,
  type AgentInvocation,
  type TrackedAgentExecutionRequest,
} from '../agent-run.ts';

const AGENT_TIMEOUT_MS = 15 * 60_000;

async function invokeExplainer(
  sandbox: Sandbox,
  stageRun: StageRunRow,
  request: TrackedAgentExecutionRequest,
  output: ZodType<ExplanationArtifact>,
): Promise<AgentInvocation<ExplanationArtifact>> {
  if (request.repositoryAccess !== 'none')
    throw new Error('explainer must not access a repository');
  const auth = await resolveRunnerAuth(request.model, request.usage);
  const sanitize = (value: string) => redactSecrets(value, Object.values(auth.vars));
  const result = await runStructuredAgent({
    sandbox,
    auth,
    request,
    output,
    cwd: '/workspace',
    promptFile: `/workspace/explain-${stageRun.id}.md`,
    artifactFile: `/workspace/explain-${stageRun.id}.json`,
    timeout: AGENT_TIMEOUT_MS,
    sanitize,
  });
  return { artifact: result.artifact, run: result.run, sanitize };
}

export async function executeExplanationStage(
  factoryRun: FactoryRunRow,
  stageRun: StageRunRow,
): Promise<{ revisionId: number; artifactId: number }> {
  if (!factoryRun.change_id) throw new Error('explanation run has no change');
  const change = await getChange(factoryRun.change_id);
  if (!change || change.organization_id !== factoryRun.organization_id) {
    throw new Error('explanation change is missing');
  }
  const revision = await latestChangeRevision(change.id);
  if (!revision) throw new Error('change has no immutable revision');
  const revisionRow = await getArtifact(revision.artifact_id);
  if (!revisionRow || revisionRow.organization_id !== factoryRun.organization_id) {
    throw new Error('change revision artifact is missing');
  }
  const source = await loadJsonArtifact(revisionRow, changeRevisionArtifactSchema);
  await ensureBuiltinAgents(factoryRun.organization_id);
  const agent = await getAgentBySlug(factoryRun.organization_id, 'explainer');
  if (!agent?.enabled || agent.definition_key !== explainerAgent.id) {
    throw new Error('explainer agent is unavailable');
  }

  const value: ExplainerInput = {
    revisionId: revision.id,
    title: source.title,
    headSha: source.headSha,
    changedPaths: source.files.map((file) => file.path),
    patch: source.patch,
  };
  const sandbox = runnerSandbox(`explain--${factoryRun.id}`, { sleepAfter: '10m' });
  try {
    const tracked = await runTrackedAgent({
      factoryRun,
      stageRun,
      agent,
      definition: explainerAgent,
      value,
      inputKind: 'explainer_input',
      outputKind: 'explanation',
      invoke: (request, output) => invokeExplainer(sandbox, stageRun, request, output),
    });
    return { revisionId: revision.id, artifactId: tracked.outputArtifactId };
  } finally {
    await sandbox
      .exec(`rm -f /workspace/explain-${stageRun.id}.md /workspace/explain-${stageRun.id}.json`)
      .catch(() => undefined);
  }
}
