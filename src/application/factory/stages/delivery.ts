import { invokeImplementer, runtimeSkills, repositorySettings } from '../invoke-implementer.ts';
import { repositoryPolicy } from '../../../domain/repository-policy.ts';
import { syncGithubChangeRevision } from '../../changes/github-revision.ts';
import { implementerAgent, type ImplementerInput } from '../../../agents/implementer.ts';
import { changeRevisionArtifactSchema } from '../../../artifacts/change.ts';
import { storedPlanArtifactSchema } from '../../../artifacts/plan.ts';
import { runCheckCommand } from '../../../integrations/agent-runtime/check-command.ts';
import { redactSecrets } from '../../../integrations/agent-runtime/redaction.ts';
import { generationSandbox } from '../../../integrations/agent-runtime/sandbox.ts';
import { mountSkills } from '../../../integrations/agent-runtime/skills.ts';
import {
  completeWorkItemWhenDelivered,
  getDelivery,
  getWorkItem,
  updateDeliveryStatus,
} from '../../../data/work.ts';
import { ensureBuiltinAgents, getAgent, getAgentBySlug } from '../../../data/agents.ts';
import { getArtifact } from '../../../data/artifacts.ts';
import { getAutomation } from '../../../data/automations.ts';
import {
  createChangeRevision,
  listChangesForDelivery,
  upsertChange,
} from '../../../data/changes.ts';
import { type FactoryRunRow, type StageRunRow } from '../../../data/execution.ts';
import {
  listAutomationIntegrations,
  listRepositoryIntegrations,
} from '../../../data/integrations.ts';
import { getRepository, type RepositoryRow } from '../../../data/repositories.ts';
import {
  listSkillsForAgent,
  listSkillsForAutomation,
  listSkillsForRepository,
} from '../../../data/skills.ts';
import { buildReviewDiffSnapshot } from '../../../domain/review-context.ts';
import { remoteSourceOf, resolveWorkspaceRemote } from '../../../integrations/git/provider.ts';
import { authorizesWorkflowFiles, installationToken } from '../../../integrations/github/app.ts';
import { githubJson } from '../../../integrations/github/client.ts';
import { buildSandboxMcpConfig } from '../../integrations/mcp-proxy.ts';
import { loadJsonArtifact, persistJsonArtifact } from '../../artifacts.ts';
import { runTrackedAgent } from '../agent-run.ts';

const CHECK_TIMEOUT_MS = 12 * 60_000;

function branchName(deliveryId: number, title: string): string {
  const slug = title
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 40);
  return `turbodiff/delivery-${deliveryId}-${slug || 'change'}`;
}

async function openGithubPullRequest(input: {
  repository: RepositoryRow;
  branch: string;
  base: string;
  title: string;
  summary: string;
  notes: string | null;
}): Promise<{ number: number; html_url: string }> {
  const installationId = Number(input.repository.source_external_account_id);
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    throw new Error('GitHub repository has no installation');
  }
  const body =
    input.summary +
    (input.notes
      ? `\n\n<details><summary>Implementation notes</summary>\n\n${input.notes}\n\n</details>`
      : '') +
    '\n\n---\n_turbodiff factory_';
  return githubJson(
    await installationToken(installationId),
    `/repos/${input.repository.owner}/${input.repository.name}/pulls`,
    {
      method: 'POST',
      body: JSON.stringify({
        title: input.title,
        head: input.branch,
        base: input.base,
        body,
      }),
    },
  );
}

export async function executeDeliveryStage(
  factoryRun: FactoryRunRow,
  stageRun: StageRunRow,
): Promise<{ changeId: number | null; outcome: 'change_created' | 'no_change' }> {
  if (!factoryRun.delivery_id) throw new Error('delivery run has no delivery');
  const delivery = await getDelivery(factoryRun.delivery_id);
  if (!delivery || delivery.organization_id !== factoryRun.organization_id) {
    throw new Error('delivery is missing');
  }
  const existing = (await listChangesForDelivery(delivery.id))[0];
  if (existing) {
    const repository = await getRepository(delivery.repository_id);
    if (
      factoryRun.flow_version < 2 ||
      !repository ||
      !repositoryPolicy(repository.settings).verify
    ) {
      await updateDeliveryStatus(delivery.id, 'completed');
      await completeWorkItemWhenDelivered(delivery.work_item_id);
    }
    return { changeId: existing.id, outcome: 'change_created' };
  }
  const [repository, workItem] = await Promise.all([
    getRepository(delivery.repository_id),
    getWorkItem(delivery.work_item_id),
  ]);
  if (!repository?.enabled || repository.organization_id !== factoryRun.organization_id) {
    throw new Error('delivery repository is missing or disabled');
  }
  if (!workItem?.approved_plan_artifact_id) throw new Error('delivery has no approved plan');
  const planRow = await getArtifact(workItem.approved_plan_artifact_id);
  if (!planRow || planRow.organization_id !== factoryRun.organization_id) {
    throw new Error('approved plan artifact is missing');
  }
  const plan = await loadJsonArtifact(planRow, storedPlanArtifactSchema);

  await ensureBuiltinAgents(factoryRun.organization_id);
  const automation = factoryRun.automation_id
    ? await getAutomation(factoryRun.automation_id)
    : null;
  const agent = automation
    ? await getAgent(automation.agent_id)
    : await getAgentBySlug(factoryRun.organization_id, 'implementer');
  if (
    !agent?.enabled ||
    agent.organization_id !== factoryRun.organization_id ||
    agent.definition_key !== implementerAgent.id
  ) {
    throw new Error('implementer agent is unavailable');
  }

  const sandbox = generationSandbox(repository);
  const cacheDir = '/workspace/repo-cache';
  const workDir = `/workspace/delivery-${delivery.id}`;
  const promptFile = `/workspace/delivery-${delivery.id}.md`;
  const summaryFile = `/workspace/delivery-${delivery.id}-summary.md`;
  const notesFile = `/workspace/delivery-${delivery.id}-notes.md`;
  const branch = branchName(delivery.id, workItem.title);
  const base = repository.default_branch ?? 'main';
  const remote = await resolveWorkspaceRemote(remoteSourceOf(repository), 'write', {
    workflows: authorizesWorkflowFiles(plan.plan),
  });
  const { prepareCachedWorktree, pushHeadCommand } =
    await import('../../../integrations/agent-runtime/repository-workspace.ts');
  await prepareCachedWorktree({ sandbox, cacheDir, workDir, remote, base, branch });
  let completed = false;
  try {
    const skills = await Promise.all([
      listSkillsForRepository(repository.id),
      listSkillsForAgent(agent.id),
      ...(automation ? [listSkillsForAutomation(automation.id)] : []),
    ]);
    await mountSkills(sandbox, workDir, runtimeSkills(skills.flat()));
    const [repositoryIntegrations, automationIntegrations] = await Promise.all([
      listRepositoryIntegrations(repository.id),
      automation ? listAutomationIntegrations(automation.id) : [],
    ]);
    const mcp = await buildSandboxMcpConfig([
      ...repositoryIntegrations.map((integration) => ({
        integration,
        repositoryId: repository.id,
      })),
      ...automationIntegrations.map((integration) => ({
        integration,
        repositoryId: repository.id,
        automationId: automation!.id,
      })),
    ]);
    const settings = repositorySettings(repository);
    const implementerInput: ImplementerInput = {
      operation: 'implement',
      repository: `${repository.owner}/${repository.name}`,
      title: workItem.title,
      instructions: plan.plan,
      scope: 'standard',
      testing: 'repository-patterns',
      noChangeOutcome: 'unexpected',
      check: settings.checkCommand
        ? { kind: 'gated', command: settings.checkCommand }
        : { kind: 'harness', command: null },
      outputFiles: {
        summary: summaryFile,
        notes: notesFile,
      },
    };
    const tracked = await runTrackedAgent({
      factoryRun,
      stageRun,
      agent,
      definition: implementerAgent,
      value: implementerInput,
      inputKind: 'implementer_input',
      outputKind: 'repository_change',
      invoke: (request, output) =>
        invokeImplementer(
          agent,
          repository,
          workDir,
          promptFile,
          summaryFile,
          notesFile,
          request,
          output,
          mcp,
        ),
    });
    if (tracked.artifact.kind === 'no-change') {
      await updateDeliveryStatus(delivery.id, 'completed');
      await completeWorkItemWhenDelivered(delivery.work_item_id);
      completed = true;
      return { changeId: null, outcome: 'no_change' };
    }

    const commit = await sandbox.exec(
      `git -C ${workDir} add -A && git -C ${workDir} commit -m "$COMMIT_MESSAGE"`,
      {
        env: { COMMIT_MESSAGE: `${workItem.title} (turbodiff delivery #${delivery.id})` },
        timeout: 60_000,
      },
    );
    if (!commit.success) throw new Error(`git commit failed: ${commit.stderr.slice(-500)}`);
    if (
      settings.checkCommand &&
      (factoryRun.flow_version < 2 || !repositoryPolicy(repository.settings).verify)
    ) {
      const checked = await runCheckCommand(
        sandbox,
        workDir,
        settings.checkCommand,
        (value) => redactSecrets(value, [remote.token]),
        CHECK_TIMEOUT_MS,
      );
      if (!checked.ok) throw new Error(`repository check failed: ${checked.output.slice(-1_000)}`);
    }
    const pushed = await sandbox.exec(pushHeadCommand(remote, workDir), {
      env: { ...remote.env, PUSH_BRANCH: branch },
      timeout: 5 * 60_000,
    });
    if (!pushed.success) {
      throw new Error(
        `git push failed: ${redactSecrets(pushed.stderr, [remote.token]).slice(-500)}`,
      );
    }

    const [baseResult, headResult, diffResult] = await Promise.all([
      sandbox.exec(`git -C ${workDir} rev-parse "$BASE_REF"`, { env: { BASE_REF: base } }),
      sandbox.exec(`git -C ${workDir} rev-parse HEAD`),
      sandbox.exec(`git -C ${workDir} diff --no-ext-diff "$BASE_REF"...HEAD`, {
        env: { BASE_REF: base },
      }),
    ]);
    if (!baseResult.success || !headResult.success || !diffResult.success) {
      throw new Error('could not create the normalized change revision');
    }
    const baseSha = baseResult.stdout.trim();
    const headSha = headResult.stdout.trim();
    const snapshot = buildReviewDiffSnapshot(diffResult.stdout);
    const pullRequest =
      repository.source_provider === 'github'
        ? await openGithubPullRequest({
            repository,
            branch,
            base,
            title: workItem.title,
            summary: tracked.artifact.summary,
            notes: tracked.artifact.notes,
          })
        : null;
    const change = await upsertChange({
      organizationId: factoryRun.organization_id,
      repositoryId: repository.id,
      deliveryId: delivery.id,
      providerIntegrationId: repository.source_integration_id,
      providerKey: pullRequest ? `pull_request:${pullRequest.number}` : `branch:${branch}`,
      number: pullRequest?.number ?? null,
      title: workItem.title,
      sourceRef: branch,
      targetRef: base,
      url: pullRequest?.html_url ?? null,
      origin: factoryRun.automation_id ? 'automation' : 'factory',
      status: 'open',
    });
    if (repository.source_provider === 'github')
      await syncGithubChangeRevision(repository, change, headSha);
    else {
      const revisionArtifact = await persistJsonArtifact({
        organizationId: factoryRun.organization_id,
        kind: 'change_revision',
        storageKey: `organizations/${factoryRun.organization_id}/changes/${change.id}/revisions/${headSha}.json`,
        schema: changeRevisionArtifactSchema,
        value: {
          kind: 'change-revision',
          title: workItem.title,
          description: tracked.artifact.summary,
          base,
          head: branch,
          baseSha,
          headSha,
          files: snapshot.files,
          patch: snapshot.diff,
        },
      });
      await createChangeRevision({
        change,
        baseSha,
        headSha,
        artifactId: revisionArtifact.id,
      });
    }
    if (factoryRun.flow_version < 2 || !repositoryPolicy(repository.settings).verify) {
      await updateDeliveryStatus(delivery.id, 'completed');
      await completeWorkItemWhenDelivered(delivery.work_item_id);
    }
    completed = true;
    return { changeId: change.id, outcome: 'change_created' };
  } finally {
    if (completed) {
      await sandbox
        .exec(`rm -rf ${workDir} ${promptFile} ${summaryFile} ${notesFile}`)
        .catch(() => undefined);
    }
  }
}
