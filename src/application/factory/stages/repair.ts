import { authorizesWorkflowFiles } from '../../../integrations/github/app.ts';
import { z } from 'zod';
import { implementerAgent } from '../../../agents/implementer.ts';
import { changeRevisionArtifactSchema } from '../../../artifacts/change.ts';
import { reviewArtifactSchema } from '../../../artifacts/review.ts';
import { verificationEvidenceSchema } from '../../../artifacts/verification.ts';
import { ensureBuiltinAgents, getAgentBySlug } from '../../../data/agents.ts';
import { getArtifact, getArtifactByStorageKey } from '../../../data/artifacts.ts';
import {
  createChangeRevision,
  getChange,
  latestChangeRevision,
  listReviewOutcomes,
  type ChangeRow,
  type ChangeRevisionRow,
} from '../../../data/changes.ts';
import {
  listAgentRunsForStage,
  listLifecycleEvents,
  type FactoryRunRow,
  type StageRunRow,
} from '../../../data/execution.ts';
import { getIntegration } from '../../../data/integrations.ts';
import { getRepository, type RepositoryRow } from '../../../data/repositories.ts';
import { repositoryPolicy } from '../../../domain/repository-policy.ts';
import { buildReviewDiffSnapshot } from '../../../domain/review-context.ts';
import { runCodingAgent } from '../../../integrations/agent-runtime/coding-agent.ts';
import { readRepositoryChangeArtifact } from '../../../integrations/agent-runtime/repository-change-artifact.ts';
import { generationSandbox } from '../../../integrations/agent-runtime/sandbox.ts';
import { pushHeadCommand } from '../../../integrations/agent-runtime/repository-workspace.ts';
import { remoteSourceOf, resolveWorkspaceRemote } from '../../../integrations/git/provider.ts';
import { redactSecrets } from '../../../integrations/agent-runtime/redaction.ts';
import { readGithubDeliveryState } from '../../../integrations/changes/github-delivery.ts';
import { isJsonObject, isNumber } from '../../../shared/json.ts';
import { loadJsonArtifact, persistJsonArtifact } from '../../artifacts.ts';
import { syncGithubChangeRevision } from '../../changes/github-revision.ts';
import { runTrackedAgent } from '../agent-run.ts';
import { resolveRunnerAuth } from '../runner-auth.ts';
import { deliveryWorkspace } from './delivery-workspace.ts';
import { deliveryTask } from './verification.ts';

const repairEvidenceSchema = z.object({ evidence: z.string() });
async function repairEvidence(
  run: FactoryRunRow,
  stage: StageRunRow,
  repository: RepositoryRow,
  change: ChangeRow,
  revision: ChangeRevisionRow,
) {
  const key = `organizations/${run.organization_id}/stage-runs/${stage.id}/repair-evidence.json`;
  const existing = await getArtifactByStorageKey(key);
  if (existing) return (await loadJsonArtifact(existing, repairEvidenceSchema)).evidence;
  const evidence: string[] = [];
  if (repository.source_provider === 'github')
    evidence.push((await readGithubDeliveryState(repository, change, true)).failureEvidence);
  for (const outcome of await listReviewOutcomes(revision.id)) {
    const row = await getArtifact(outcome.output_artifact_id);
    if (row) evidence.push(JSON.stringify(await loadJsonArtifact(row, reviewArtifactSchema)));
  }
  for (const event of await listLifecycleEvents(run.id)) {
    const payload = event.payload;
    if (
      event.kind !== 'delivery_stage_completed' ||
      !isJsonObject(payload) ||
      payload.revisionId !== revision.id ||
      !isNumber(payload.artifactId)
    )
      continue;
    const row = await getArtifact(payload.artifactId);
    if (row?.kind === 'verification_evidence')
      evidence.push(JSON.stringify(await loadJsonArtifact(row, verificationEvidenceSchema)));
  }
  const value = {
    evidence:
      evidence.join('\n\n').slice(-100_000) ||
      'Delivery checks failed. Inspect the configured checks and report any unavailable evidence.',
  };
  await persistJsonArtifact({
    organizationId: run.organization_id,
    kind: 'repair_evidence',
    storageKey: key,
    schema: repairEvidenceSchema,
    value,
  });
  return value.evidence;
}

export async function assertDeliveryWritable(
  repository: RepositoryRow,
  change: ChangeRow,
  revision: ChangeRevisionRow,
) {
  const [freshRepo, freshChange, integration, latest] = await Promise.all([
    getRepository(repository.id),
    getChange(change.id),
    getIntegration(repository.source_integration_id),
    latestChangeRevision(change.id),
  ]);
  if (
    !freshRepo?.enabled ||
    !integration?.enabled ||
    freshChange?.status !== 'open' ||
    !repositoryPolicy(freshRepo.settings).repair ||
    latest?.id !== revision.id
  ) {
    throw new Error('Delivery policy or revision changed; refusing to write');
  }
  if (repository.source_provider === 'github') {
    const state = await readGithubDeliveryState(repository, change);
    if (
      !state.writable ||
      state.status !== 'open' ||
      state.draft ||
      state.headSha !== revision.head_sha
    )
      throw new Error('Pull request changed; refusing to write');
  }
}

export async function executeRepair(
  run: FactoryRunRow,
  stage: StageRunRow,
  repository: RepositoryRow,
  change: ChangeRow,
  revision: ChangeRevisionRow,
) {
  await assertDeliveryWritable(repository, change, revision);
  const task = await deliveryTask(change);
  const revisionArtifact = await loadJsonArtifact(
    revision.artifact_id,
    changeRevisionArtifactSchema,
  );
  const workflows =
    authorizesWorkflowFiles(task.plan.plan) ||
    revisionArtifact.files.some((file) => file.path.startsWith('.github/workflows/'));
  const evidence = await repairEvidence(run, stage, repository, change, revision);
  await ensureBuiltinAgents(run.organization_id);
  const agent = await getAgentBySlug(run.organization_id, 'implementer');
  if (!agent?.enabled) throw new Error('Implementer agent is unavailable');
  const sandbox = generationSandbox(repository);
  const workDir = `/workspace/completion-${stage.id}`;
  const prior = (await listAgentRunsForStage(stage.id)).find((item) => item.agent_id === agent.id);
  const remote = await resolveWorkspaceRemote(remoteSourceOf(repository), 'write', {
    workflows,
  });
  const scrub = (value: string) => redactSecrets(value, [remote.token]);
  // Preserve the exact edited checkout when retrying publication after an agent completed.
  if (prior?.status === 'succeeded') {
    const present = await sandbox.exec(`test -d ${workDir}/.git`);
    if (!present.success)
      throw new Error('Repair workspace expired before publication; resume delivery to retry');
  } else await deliveryWorkspace(repository, change, revision, stage.id, 'write', workflows);
  const originalTaskFile = `/workspace/repair-${stage.id}-task.md`;
  const promptFile = `/workspace/repair-${stage.id}.md`;
  const summary = `/workspace/repair-${stage.id}-summary.md`;
  const notes = `/workspace/repair-${stage.id}-notes.md`;
  await sandbox.writeFile(originalTaskFile, task.plan.plan);
  const tracked = await runTrackedAgent({
    factoryRun: run,
    stageRun: stage,
    agent,
    definition: implementerAgent,
    value: {
      operation: 'repair',
      checkCommand: repositoryPolicy(repository.settings).checkCommand,
      checkOutput: evidence,
      freshSession: true,
      originalTaskFile,
      outputFiles: { summary, notes },
    },
    inputKind: 'implementer_input',
    outputKind: 'repository_change',
    invoke: async (request, output) => {
      const auth = await resolveRunnerAuth(request.model);
      const sanitize = (value: string) => redactSecrets(scrub(value), Object.values(auth.vars));
      await sandbox.writeFile(promptFile, request.prompt);
      const result = await runCodingAgent(sandbox, auth, {
        promptFile,
        cwd: workDir,
        timeout: 25 * 60_000,
      });
      if (!result.success)
        throw new Error(`Repair failed: ${sanitize(result.stderr).slice(-1_000)}`);
      return {
        artifact: await readRepositoryChangeArtifact(
          sandbox,
          workDir,
          output,
          { summary, notes },
          'Delivery repair',
        ),
        run: result,
        sanitize,
      };
    },
  });
  if (tracked.artifact.kind === 'no-change')
    return { revisionId: revision.id, verdict: 'unchanged' };
  // Agents never own git publication. Allow one harness commit on retry, but no unrelated ancestry.
  const parent = await sandbox.exec(`git -C ${workDir} rev-parse HEAD`);
  if (parent.stdout.trim() === revision.head_sha) {
    const committed = await sandbox.exec(
      `git -C ${workDir} add -A && git -C ${workDir} commit -m "Repair delivery validation"`,
    );
    if (!committed.success)
      throw new Error(`Repair commit failed: ${scrub(committed.stderr).slice(-500)}`);
  }
  const ancestry = await sandbox.exec(`git -C ${workDir} rev-parse HEAD^`);
  if (ancestry.stdout.trim() !== revision.head_sha)
    throw new Error('Repair must contain exactly one commit on the expected head');
  await assertDeliveryWritable(repository, change, revision);
  const pushed = await sandbox.exec(pushHeadCommand(remote, workDir), {
    env: { ...remote.env, PUSH_BRANCH: change.source_ref },
    timeout: 5 * 60_000,
  });
  if (!pushed.success) throw new Error(`Repair push failed: ${scrub(pushed.stderr).slice(-500)}`);
  if (repository.source_provider === 'github') await syncGithubChangeRevision(repository, change);
  else {
    const [head, patch] = await Promise.all([
      sandbox.exec(`git -C ${workDir} rev-parse HEAD`),
      sandbox.exec(`git -C ${workDir} diff --no-ext-diff "$BASE_SHA"...HEAD`, {
        env: { BASE_SHA: revision.base_sha },
      }),
    ]);
    if (!head.success || !patch.success) throw new Error('Could not capture repaired revision');
    const snapshot = buildReviewDiffSnapshot(patch.stdout);
    const artifact = await persistJsonArtifact({
      organizationId: run.organization_id,
      kind: 'change_revision',
      storageKey: `organizations/${run.organization_id}/changes/${change.id}/revisions/${head.stdout.trim()}.json`,
      schema: changeRevisionArtifactSchema,
      value: {
        kind: 'change-revision',
        title: change.title,
        description: tracked.artifact.summary,
        base: change.target_ref,
        head: change.source_ref,
        baseSha: revision.base_sha,
        headSha: head.stdout.trim(),
        files: snapshot.files,
        patch: snapshot.diff,
      },
    });
    await createChangeRevision({
      change,
      baseSha: revision.base_sha,
      headSha: head.stdout.trim(),
      artifactId: artifact.id,
    });
  }
  await sandbox
    .exec(`rm -rf ${workDir} ${originalTaskFile} ${promptFile} ${summary} ${notes}`)
    .catch(() => undefined);
  return { revisionId: revision.id, verdict: 'repaired' };
}
