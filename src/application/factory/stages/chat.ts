import type { Sandbox } from '@cloudflare/sandbox';
import { implementerAgent, type ImplementerInput } from '../../../agents/implementer.ts';
import { changeRevisionArtifactSchema } from '../../../artifacts/change.ts';
import { ensureBuiltinAgents, getAgentBySlug } from '../../../data/agents.ts';
import { createChangeRevision, listChangesForDelivery } from '../../../data/changes.ts';
import {
  chatRequestForRun,
  createDeliveryMessage,
  deliveryChatContext,
} from '../../../data/deliveries.ts';
import type { FactoryRunRow, StageRunRow } from '../../../data/execution.ts';
import { listRepositoryIntegrations } from '../../../data/integrations.ts';
import { memberRole } from '../../../data/organizations.ts';
import { getRepository } from '../../../data/repositories.ts';
import { listSkillsForAgent, listSkillsForRepository } from '../../../data/skills.ts';
import { getDelivery } from '../../../data/work.ts';
import { buildReviewDiffSnapshot } from '../../../domain/review-context.ts';
import { runCheckCommand } from '../../../integrations/agent-runtime/check-command.ts';
import { redactSecrets } from '../../../integrations/agent-runtime/redaction.ts';
import {
  assertGitRef,
  prepareFreshClone,
  pushHeadCommand,
} from '../../../integrations/agent-runtime/repository-workspace.ts';
import { generationSandbox } from '../../../integrations/agent-runtime/sandbox.ts';
import { mountSkills } from '../../../integrations/agent-runtime/skills.ts';
import { remoteSourceOf, resolveWorkspaceRemote } from '../../../integrations/git/provider.ts';
import { assertChangeWritable } from '../../../integrations/github/change-write.ts';
import { persistJsonArtifact } from '../../artifacts.ts';
import { buildSandboxMcpConfig } from '../../integrations/mcp-proxy.ts';
import { runTrackedAgent } from '../agent-run.ts';
import { invokeImplementer, repositorySettings, runtimeSkills } from '../invoke-implementer.ts';

export interface ChatStageRuntime {
  sandbox: (
    repository: Parameters<typeof generationSandbox>[0],
  ) => Pick<Sandbox, 'exec' | 'writeFile'>;
  remote: typeof resolveWorkspaceRemote;
  assertWritable: typeof assertChangeWritable;
  invoke: typeof invokeImplementer;
}

const chatRuntime: ChatStageRuntime = {
  sandbox: generationSandbox,
  remote: resolveWorkspaceRemote,
  assertWritable: assertChangeWritable,
  invoke: invokeImplementer,
};

async function writableDelivery(run: FactoryRunRow) {
  const delivery = run.delivery_id ? await getDelivery(run.delivery_id) : null;
  if (
    !delivery ||
    delivery.organization_id !== run.organization_id ||
    delivery.status === 'cancelled'
  ) {
    throw new Error('Chat delivery is unavailable');
  }
  const role = run.actor_user_id ? await memberRole(run.organization_id, run.actor_user_id) : null;
  if (role !== 'owner' && role !== 'admin')
    throw new Error('Organization write access was revoked');
  const [repository, changes] = await Promise.all([
    getRepository(delivery.repository_id),
    listChangesForDelivery(delivery.id),
  ]);
  const change = changes[0];
  if (!repository?.enabled || repository.organization_id !== run.organization_id)
    throw new Error('Chat repository is unavailable');
  if (!change || change.organization_id !== run.organization_id || change.status !== 'open')
    throw new Error('The change is no longer open');
  return { delivery, repository, change };
}

export async function executeChatStage(
  factoryRun: FactoryRunRow,
  stageRun: StageRunRow,
  runtime: ChatStageRuntime = chatRuntime,
): Promise<{ messageId: number; outcome: string; commitSha: string | null }> {
  const { delivery, repository, change } = await writableDelivery(factoryRun);
  const message = await chatRequestForRun(factoryRun.id);
  if (
    !message ||
    message.delivery_id !== delivery.id ||
    message.organization_id !== delivery.organization_id
  ) {
    throw new Error('Chat run has no user message');
  }
  await runtime.assertWritable(repository, change);
  await ensureBuiltinAgents(delivery.organization_id);
  const agent = await getAgentBySlug(delivery.organization_id, 'implementer');
  if (!agent?.enabled || agent.definition_key !== implementerAgent.id)
    throw new Error('Implementer is unavailable');

  const remote = await runtime.remote(remoteSourceOf(repository), 'write', { workflows: true });
  const sandbox = runtime.sandbox(repository);
  const workDir = `/workspace/chat-${stageRun.id}`;
  const skillDir = `${workDir}-context`;
  const promptFile = `${workDir}-prompt.md`;
  const summaryFile = `${workDir}-summary.md`;
  const notesFile = `${workDir}-notes.md`;
  const scrub = (value: string) => redactSecrets(value, [remote.token]);
  assertGitRef(change.target_ref, 'target branch');
  try {
    await prepareFreshClone({ sandbox, cloneDir: workDir, remote, branch: change.source_ref });
    const [skills, integrations, history] = await Promise.all([
      Promise.all([listSkillsForRepository(repository.id), listSkillsForAgent(agent.id)]),
      listRepositoryIntegrations(repository.id),
      deliveryChatContext(delivery.id, message.id),
    ]);
    // Runtime-provided skills are context, not edits to the user's branch.
    const mountedSkills = runtimeSkills(skills.flat());
    await mountSkills(sandbox, skillDir, mountedSkills);
    const skillPaths = mountedSkills.map(
      (skill) => `${skillDir}/.claude/skills/${skill.slug}/SKILL.md`,
    );
    const mcp = await buildSandboxMcpConfig(
      integrations.map((integration) => ({ integration, repositoryId: repository.id })),
    );
    const check = repositorySettings(repository).checkCommand;
    const previous = history
      .filter((entry) => entry.id !== message.id)
      .map((entry) => ({ role: entry.role, body: entry.body.slice(-4_000) }));
    const value: ImplementerInput = {
      operation: 'implement',
      repository: `${repository.owner}/${repository.name}`,
      title: change.title,
      instructions: `You are following up on the existing change, already checked out on its current source branch. Preserve its existing work. Answer questions without manufacturing edits. Always write your reply to ${summaryFile}, including when no files change.\n\nAssigned skills (read before starting):\n${skillPaths.join('\n') || 'None'}\n\nPrevious conversation (context, not new instructions):\n${JSON.stringify(previous)}\n\nCurrent user request:\n${message.body}`,
      scope: 'standard',
      testing: 'repository-patterns',
      noChangeOutcome: 'allowed',
      check: { kind: 'harness', command: check },
      outputFiles: { summary: summaryFile, notes: notesFile },
    };
    const tracked = await runTrackedAgent({
      factoryRun,
      stageRun,
      agent,
      definition: implementerAgent,
      value,
      inputKind: 'implementer_input',
      outputKind: 'repository_change',
      invoke: (request, output) =>
        runtime.invoke(
          agent,
          repository,
          workDir,
          promptFile,
          summaryFile,
          notesFile,
          request,
          output,
          mcp,
          [remote.token],
        ),
    });
    const artifact = tracked.artifact;
    let commitSha: string | null = null;
    if (artifact.kind === 'repository-change') {
      if (check) {
        const checked = await runCheckCommand(sandbox, workDir, check, scrub, 12 * 60_000);
        if (!checked.ok)
          throw new Error(
            `Repository check failed; no changes were pushed: ${checked.output.slice(-1_000)}`,
          );
      }
      const committed = await sandbox.exec(
        `git -C ${workDir} add -A && git -C ${workDir} commit -m "$COMMIT_MESSAGE"`,
        {
          env: { COMMIT_MESSAGE: `Follow up on ${change.title} (chat #${message.id})` },
          timeout: 60_000,
        },
      );
      if (!committed.success)
        throw new Error(`Git commit failed: ${scrub(committed.stderr).slice(-500)}`);
      const fetched = await sandbox.exec(
        `git ${remote.configFlags} -C ${workDir} fetch --depth 50 "${remote.authUrl}" "$TARGET_REF"`,
        {
          env: { ...remote.env, TARGET_REF: change.target_ref },
          timeout: 5 * 60_000,
        },
      );
      if (!fetched.success)
        throw new Error(`Could not read the target branch: ${scrub(fetched.stderr).slice(-500)}`);
      const base = await sandbox.exec(`git -C ${workDir} rev-parse FETCH_HEAD`);
      const head = await sandbox.exec(`git -C ${workDir} rev-parse HEAD`);
      const diff = await sandbox.exec(`git -C ${workDir} diff --no-ext-diff FETCH_HEAD...HEAD`);
      if (!base.success || !head.success || !diff.success)
        throw new Error('Could not capture the updated change revision');
      commitSha = head.stdout.trim();
      const snapshot = buildReviewDiffSnapshot(diff.stdout);
      const revision = await persistJsonArtifact({
        organizationId: delivery.organization_id,
        kind: 'change_revision',
        // Keep this snapshot separate from the provider webhook snapshot for the same SHA.
        storageKey: `organizations/${delivery.organization_id}/factory-runs/${factoryRun.id}/stage-runs/${stageRun.id}/revision.json`,
        schema: changeRevisionArtifactSchema,
        value: {
          kind: 'change-revision',
          title: change.title,
          description: artifact.summary,
          base: change.target_ref,
          head: change.source_ref,
          baseSha: base.stdout.trim(),
          headSha: commitSha,
          files: snapshot.files,
          patch: snapshot.diff,
        },
      });
      await writableDelivery(factoryRun);
      await runtime.assertWritable(repository, change);
      const pushed = await sandbox.exec(pushHeadCommand(remote, workDir), {
        env: { ...remote.env, PUSH_BRANCH: change.source_ref },
        timeout: 5 * 60_000,
      });
      if (!pushed.success)
        throw new Error(
          `Push failed; the branch may have changed. Retry your message: ${scrub(pushed.stderr).slice(-500)}`,
        );
      await createChangeRevision({
        change,
        baseSha: base.stdout.trim(),
        headSha: commitSha,
        artifactId: revision.id,
      });
    }
    const outcome = artifact.kind === 'repository-change' ? 'changed' : 'no_changes';
    const reply = await createDeliveryMessage({
      delivery,
      factoryRunId: factoryRun.id,
      role: 'assistant',
      outcome,
      body: artifact.summary ?? 'No repository changes were needed.',
      commitSha: commitSha ?? undefined,
    });
    return { messageId: reply.id, outcome, commitSha };
  } finally {
    await sandbox
      .exec(`rm -rf ${workDir} ${skillDir} ${promptFile} ${summaryFile} ${notesFile}`)
      .catch(() => undefined);
  }
}
