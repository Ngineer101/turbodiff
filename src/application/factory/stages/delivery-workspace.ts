import {
  generationSandbox,
  retrySandboxOperation,
} from '../../../integrations/agent-runtime/sandbox.ts';
import { prepareFreshClone } from '../../../integrations/agent-runtime/repository-workspace.ts';
import { remoteSourceOf, resolveWorkspaceRemote } from '../../../integrations/git/provider.ts';
import { redactSecrets } from '../../../integrations/agent-runtime/redaction.ts';
import type { RepositoryRow } from '../../../data/repositories.ts';
import type { ChangeRow, ChangeRevisionRow } from '../../../data/changes.ts';

export async function deliveryWorkspace(
  repository: RepositoryRow,
  change: ChangeRow,
  revision: ChangeRevisionRow,
  stageId: number,
  access: 'read' | 'write',
  workflows = false,
) {
  const sandbox = generationSandbox(repository);
  const workDir = `/workspace/completion-${stageId}`;
  const remote = await resolveWorkspaceRemote(remoteSourceOf(repository), access, {
    workflows: access === 'write' && workflows,
  });
  await prepareFreshClone({ sandbox, cloneDir: workDir, remote, branch: change.source_ref });
  const head = await retrySandboxOperation(() => sandbox.exec(`git -C ${workDir} rev-parse HEAD`));
  if (!head.success || head.stdout.trim() !== revision.head_sha)
    throw new Error('Delivery head changed before workspace preparation');
  return {
    sandbox,
    workDir,
    remote,
    scrub: (value: string) => redactSecrets(value, [remote.token]),
  };
}
