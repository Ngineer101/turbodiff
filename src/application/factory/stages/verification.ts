import { verifierAgent } from '../../../agents/verifier.ts';
import { verificationEvidenceSchema } from '../../../artifacts/verification.ts';
import {
  acceptanceContractArtifactSchema,
  storedPlanArtifactSchema,
} from '../../../artifacts/plan.ts';
import { ensureBuiltinAgents, getAgentByDefinition } from '../../../data/agents.ts';
import { getArtifact, getArtifactByStorageKey } from '../../../data/artifacts.ts';
import type { ChangeRow, ChangeRevisionRow } from '../../../data/changes.ts';
import type { FactoryRunRow, StageRunRow } from '../../../data/execution.ts';
import type { RepositoryRow } from '../../../data/repositories.ts';
import { activeAcceptanceContract, getDelivery, getWorkItem } from '../../../data/work.ts';
import { repositoryPolicy } from '../../../domain/repository-policy.ts';
import { runCheckCommand } from '../../../integrations/agent-runtime/check-command.ts';
import { runStructuredAgent } from '../../../integrations/agent-runtime/structured-agent.ts';
import { redactSecrets } from '../../../integrations/agent-runtime/redaction.ts';
import { loadJsonArtifact, persistJsonArtifact } from '../../artifacts.ts';
import { runTrackedAgent } from '../agent-run.ts';
import { resolveRunnerAuth } from '../runner-auth.ts';
import { deliveryWorkspace } from './delivery-workspace.ts';

export async function deliveryTask(change: ChangeRow) {
  const delivery = change.delivery_id ? await getDelivery(change.delivery_id) : null;
  const item = delivery ? await getWorkItem(delivery.work_item_id) : null;
  const plan = item?.approved_plan_artifact_id
    ? await getArtifact(item.approved_plan_artifact_id)
    : null;
  if (!delivery || !plan || plan.organization_id !== change.organization_id)
    throw new Error('Delivery has no approved plan');
  const contract = await activeAcceptanceContract(delivery.id);
  const contractRow = contract ? await getArtifact(contract.artifact_id) : null;
  return {
    plan: await loadJsonArtifact(plan, storedPlanArtifactSchema),
    criteria: contractRow
      ? (await loadJsonArtifact(contractRow, acceptanceContractArtifactSchema)).criteria
      : [],
  };
}

export async function executeVerification(
  run: FactoryRunRow,
  stage: StageRunRow,
  repository: RepositoryRow,
  change: ChangeRow,
  revision: ChangeRevisionRow,
) {
  const storageKey = `organizations/${run.organization_id}/stage-runs/${stage.id}/verification.json`;
  const existing = await getArtifactByStorageKey(storageKey);
  if (existing) {
    const evidence = await loadJsonArtifact(existing, verificationEvidenceSchema);
    return { revisionId: revision.id, verdict: evidence.verdict, artifactId: existing.id };
  }
  const task = await deliveryTask(change);
  const command = repositoryPolicy(repository.settings).checkCommand;
  await ensureBuiltinAgents(run.organization_id);
  const agent = await getAgentByDefinition(run.organization_id, verifierAgent.id);
  if (!agent?.enabled) throw new Error('Verifier agent is unavailable');
  const { sandbox, workDir, scrub } = await deliveryWorkspace(
    repository,
    change,
    revision,
    stage.id,
    'read',
  );
  try {
    const tracked = await runTrackedAgent({
      factoryRun: run,
      stageRun: stage,
      agent,
      definition: verifierAgent,
      value: {
        headSha: revision.head_sha,
        criteria: task.criteria,
        instructions: task.plan.plan,
        checkCommand: command,
      },
      inputKind: 'verifier_input',
      outputKind: 'verification',
      invoke: async (request, output) => {
        const auth = await resolveRunnerAuth(request.model, request.usage);
        const sanitize = (value: string) => redactSecrets(scrub(value), Object.values(auth.vars));
        const result = await runStructuredAgent({
          sandbox,
          auth,
          request,
          output,
          cwd: workDir,
          promptFile: `/workspace/verify-${stage.id}.md`,
          artifactFile: `/workspace/verify-${stage.id}.json`,
          timeout: 20 * 60_000,
          sanitize,
          runtimeContext:
            'Use the exact checkout. Install dependencies if required for focused checks, respecting the declared package manager. Do not modify tracked files.',
        });
        return { ...result, sanitize };
      },
    });
    const checked = command
      ? await runCheckCommand(sandbox, workDir, command, scrub, 8 * 60_000)
      : null;
    const clean = await sandbox.exec(
      `git -C ${workDir} diff --quiet && git -C ${workDir} diff --cached --quiet`,
    );
    if (!clean.success) throw new Error('Verifier modified tracked repository files');
    const verdict =
      (checked?.ok === false && !checked.notExecutable) ||
      tracked.artifact.criteria.some((item) => item.verdict === 'failed')
        ? 'failed'
        : checked?.notExecutable ||
            task.criteria.length === 0 ||
            tracked.artifact.criteria.some((item) => item.verdict === 'not_verified')
          ? 'inconclusive'
          : 'passed';
    const artifact = await persistJsonArtifact({
      organizationId: run.organization_id,
      kind: 'verification_evidence',
      storageKey,
      schema: verificationEvidenceSchema,
      value: {
        kind: 'verification-evidence',
        headSha: revision.head_sha,
        assessment: tracked.artifact,
        check:
          command && checked
            ? { command, ok: checked.ok, output: checked.output.slice(-40_000) }
            : null,
        verdict,
      },
    });
    return { revisionId: revision.id, verdict, artifactId: artifact.id };
  } finally {
    await sandbox
      .exec(`rm -rf ${workDir} /workspace/verify-${stage.id}.md /workspace/verify-${stage.id}.json`)
      .catch(() => undefined);
  }
}
