import type { Sandbox } from '@cloudflare/sandbox';
import type { ZodType } from 'zod';
import { reviewerAgent, type ReviewerInput } from '../../../agents/reviewer.ts';
import { changeRevisionArtifactSchema } from '../../../artifacts/change.ts';
import type { ReviewArtifact } from '../../../artifacts/review.ts';
import { redactSecrets } from '../../../integrations/agent-runtime/redaction.ts';
import { resolveRunnerAuth } from '../runner-auth.ts';
import { reviewSandbox } from '../../../integrations/agent-runtime/sandbox.ts';
import { mountSkills } from '../../../integrations/agent-runtime/skills.ts';
import { runStructuredAgent } from '../../../integrations/agent-runtime/structured-agent.ts';
import { prepareReviewWorkspace } from '../../../integrations/agent-runtime/review-workspace.ts';
import { reviewWorkspacePath } from '../../../integrations/agent-runtime/review-workspace-policy.ts';
import {
  ensureBuiltinAgents,
  getAgentBySlug,
  listAgentsForRepository,
  type AgentRow,
} from '../../../data/agents.ts';
import { getArtifact } from '../../../data/artifacts.ts';
import { getChange, latestChangeRevision, recordReviewOutcome } from '../../../data/changes.ts';
import { type FactoryRunRow, type StageRunRow } from '../../../data/execution.ts';
import { listRepositoryIntegrations } from '../../../data/integrations.ts';
import { getRepository } from '../../../data/repositories.ts';
import {
  listSkillsForAgent,
  listSkillsForRepository,
  type SkillRow,
} from '../../../data/skills.ts';
import { planReviewPublication } from '../../../domain/review-publication.ts';
import { remoteSourceOf, resolveWorkspaceRemote } from '../../../integrations/git/provider.ts';
import { buildSandboxMcpConfig } from '../../integrations/mcp-proxy.ts';
import { publishGithubReview } from '../../../integrations/reviews/github.ts';
import { loadJsonArtifact } from '../../artifacts.ts';
import { syncGithubChangeRevision } from '../../changes/github-revision.ts';
import { runTrackedAgent, type AgentInvocation } from '../agent-run.ts';

const AGENT_TIMEOUT_MS = 27 * 60_000;
const DEFAULT_FOCUS = `Review for demonstrated defects introduced by this change. Prioritize correctness, security, breaking behavior, and serious operational failures. Ignore style and speculative concerns.`;

function runtimeSkills(rows: SkillRow[]) {
  return [...new Map(rows.map((row) => [row.id, row])).values()].map((row) => ({
    slug: row.slug,
    name: row.name,
    description: null,
    instructions: row.content,
  }));
}

async function selectedReviewers(organizationId: string, repositoryId: number) {
  await ensureBuiltinAgents(organizationId);
  const bound = (await listAgentsForRepository(repositoryId)).filter(
    (agent) => agent.enabled && agent.definition_key === reviewerAgent.id,
  );
  if (bound.length > 0) return bound;
  const fallback = await getAgentBySlug(organizationId, 'reviewer');
  if (!fallback?.enabled) throw new Error('reviewer agent is unavailable');
  return [fallback];
}

async function invokeReviewer(input: {
  sandbox: Sandbox;
  workDir: string;
  patchFile: string;
  agent: AgentRow;
  repositoryId: number;
  request: Parameters<typeof runStructuredAgent>[0]['request'];
  output: ZodType<ReviewArtifact>;
  scrub: (value: string) => string;
}): Promise<AgentInvocation<ReviewArtifact>> {
  if (input.request.repositoryAccess !== 'read') throw new Error('reviewer must be read-only');
  const auth = await resolveRunnerAuth(input.request.model);
  const integrations = await listRepositoryIntegrations(input.repositoryId);
  const mcp = await buildSandboxMcpConfig(
    integrations.map((integration) => ({
      integration,
      repositoryId: input.repositoryId,
    })),
  );
  const sanitize = (value: string) =>
    redactSecrets(input.scrub(value), [...Object.values(auth.vars), ...(mcp?.secrets ?? [])]);
  const result = await runStructuredAgent({
    sandbox: input.sandbox,
    auth,
    request: input.request,
    output: input.output,
    cwd: input.workDir,
    promptFile: `/workspace/review-${input.agent.id}.md`,
    artifactFile: `/workspace/review-${input.agent.id}.json`,
    timeout: AGENT_TIMEOUT_MS,
    configExtensionJson: mcp?.configJson,
    sanitize,
    runtimeContext:
      `The checkout is at the exact revision under review. The normalized patch is at ` +
      `${input.patchFile}. Inspect and search the checkout, but do not modify it.`,
  });
  const clean = await input.sandbox.exec(
    `git -C ${input.workDir} diff --quiet && git -C ${input.workDir} diff --cached --quiet`,
  );
  if (!clean.success) throw new Error('read-only reviewer modified tracked repository files');
  return { artifact: result.artifact, run: result.run, sanitize };
}

export async function executeReviewStage(
  factoryRun: FactoryRunRow,
  stageRun: StageRunRow,
): Promise<{ revisionId: number; agentRunIds: number[] }> {
  if (!factoryRun.change_id) throw new Error('review run has no change');
  const change = await getChange(factoryRun.change_id);
  if (!change || change.organization_id !== factoryRun.organization_id) {
    throw new Error('review change is missing');
  }
  const repository = await getRepository(change.repository_id);
  if (!repository?.enabled || repository.organization_id !== factoryRun.organization_id) {
    throw new Error('review repository is missing or disabled');
  }
  let revision = await latestChangeRevision(change.id);
  if (!revision && repository.source_provider === 'github') {
    revision = await syncGithubChangeRevision(repository, change);
  }
  if (!revision) throw new Error('change has no immutable revision');
  const artifactRow = await getArtifact(revision.artifact_id);
  if (!artifactRow || artifactRow.organization_id !== factoryRun.organization_id) {
    throw new Error('change revision artifact is missing');
  }
  const revisionArtifact = await loadJsonArtifact(artifactRow, changeRevisionArtifactSchema);

  const sandbox = reviewSandbox(repository);
  let workDir: string;
  let scrub = (value: string) => value;
  if (repository.source_provider === 'github') {
    if (!change.number) throw new Error('GitHub change has no pull request number');
    const workspace = await prepareReviewWorkspace(
      repository,
      change.number,
      revision.head_sha,
      `stage-${stageRun.id}`,
    );
    workDir = workspace.workDir;
    scrub = workspace.scrub;
  } else {
    workDir = reviewWorkspacePath(`stage-${stageRun.id}`);
    const remote = await resolveWorkspaceRemote(remoteSourceOf(repository), 'read');
    scrub = (value) => redactSecrets(value, [remote.token]);
    const { prepareCachedWorktree } =
      await import('../../../integrations/agent-runtime/repository-workspace.ts');
    await prepareCachedWorktree({
      sandbox,
      cacheDir: `/workspace/review-cache-${repository.id}`,
      workDir,
      remote,
      base: change.source_ref,
    });
  }
  const patchFile = `/workspace/review-stage-${stageRun.id}.patch`;
  await sandbox.writeFile(patchFile, revisionArtifact.patch);

  const agentRunIds: number[] = [];
  try {
    for (const agent of await selectedReviewers(factoryRun.organization_id, repository.id)) {
      const skills = await Promise.all([
        listSkillsForRepository(repository.id),
        listSkillsForAgent(agent.id),
      ]);
      await mountSkills(sandbox, workDir, runtimeSkills(skills.flat()));
      const reviewerInput: ReviewerInput = {
        repository: `${repository.owner}/${repository.name}`,
        change: {
          title: revisionArtifact.title,
          description: revisionArtifact.description,
          base: revisionArtifact.base,
          head: revisionArtifact.head,
          revision: revisionArtifact.headSha,
          files: revisionArtifact.files,
        },
        focus: {
          name: agent.name,
          instructions: agent.instructions_override?.trim() || DEFAULT_FOCUS,
        },
        changedSincePreviousReview: null,
      };
      const tracked = await runTrackedAgent({
        factoryRun,
        stageRun,
        agent,
        definition: reviewerAgent,
        value: reviewerInput,
        inputKind: 'reviewer_input',
        outputKind: 'review',
        invoke: (request, output) =>
          invokeReviewer({
            sandbox,
            workDir,
            patchFile,
            agent,
            repositoryId: repository.id,
            request,
            output,
            scrub,
          }),
      });
      const publicationPlan = planReviewPublication(reviewerInput, tracked.artifact, true);
      const publication =
        repository.source_provider === 'github' && change.number
          ? await publishGithubReview(
              repository,
              change.number,
              revision.head_sha,
              agent.name,
              publicationPlan,
            )
          : null;
      await recordReviewOutcome({
        organizationId: factoryRun.organization_id,
        agentRunId: tracked.agentRunId,
        changeRevisionId: revision.id,
        verdict: publicationPlan.verdict,
        conclusion:
          publication?.kind === 'stale' ? 'inconclusive' : publicationPlan.readiness.conclusion,
        coverageStatus:
          publication?.kind === 'stale' ? 'stale' : publicationPlan.readiness.coverageStatus,
        findingCount: publicationPlan.findings.length,
        publicationUrl: publication?.kind === 'published' ? publication.url : null,
      });
      agentRunIds.push(tracked.agentRunId);
    }
    return { revisionId: revision.id, agentRunIds };
  } finally {
    await sandbox
      .exec(`rm -rf ${workDir} ${patchFile} /workspace/review-${stageRun.id}-*.json`)
      .catch(() => undefined);
  }
}
