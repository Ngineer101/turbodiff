import { env } from 'cloudflare:workers';
import { redactSecrets } from '../../ai/runtime/redaction.ts';
import { runnerSandbox } from '../../ai/runtime/sandbox.ts';
import {
  deleteRepositoryRef,
  getRepositoryByExternalId,
  getRepositoryByProviderExternalId,
  recordRepositoryRef,
  removeRepositories,
  upsertRepositories,
  type RepositoryRow,
} from '../../data/repositories.ts';
import { getIntegration } from '../../data/integrations.ts';
import {
  artifactsRemoteUrl,
  artifactsWorkspaceRemote,
  deriveArtifactsRepoName,
} from '../../integrations/git/provider.ts';
import {
  ARTIFACTS_REPO_DELETED,
  isArtifactsPushedEvent,
  type ArtifactsEvent,
} from '../../shared/artifacts-events.ts';
import { PROJECT_SEGMENT } from '../../shared/projects.ts';

export { PROJECT_SEGMENT };

export interface CloneCredential {
  remote: string;
  token: string;
  scope: 'read' | 'write';
  expiresAt: string;
}

export interface CreatedProject {
  repo: RepositoryRow;
  remote: string;
}

function isArtifactsErrorWithCode<Failure>(failure: Failure, code: string): boolean {
  return failure instanceof Error && 'code' in failure && failure.code === code;
}

export async function createArtifactsProject(input: {
  organizationId: string;
  sourceIntegrationId: number;
  owner: string;
  name: string;
  description?: string;
}): Promise<CreatedProject> {
  if (!PROJECT_SEGMENT.test(input.owner) || !PROJECT_SEGMENT.test(input.name)) {
    throw new Error(`owner and name must match ${PROJECT_SEGMENT}`);
  }
  const integration = await getIntegration(input.sourceIntegrationId);
  if (
    !integration ||
    integration.organization_id !== input.organizationId ||
    integration.kind !== 'artifact_store' ||
    integration.provider !== 'artifacts' ||
    !integration.enabled
  ) {
    throw new Error('the selected integration is not an enabled Artifacts store');
  }

  let created: Awaited<ReturnType<typeof env.GIT_ARTIFACTS.create>> | null = null;
  for (let attempt = 0; attempt < 3 && !created; attempt++) {
    const candidate = deriveArtifactsRepoName(input.owner, input.name, attempt);
    try {
      created = await env.GIT_ARTIFACTS.create(candidate, {
        description: input.description?.trim() || `turbodiff project ${input.owner}/${input.name}`,
      });
    } catch (failure) {
      if (!isArtifactsErrorWithCode(failure, 'ALREADY_EXISTS')) throw failure;
    }
  }
  if (!created) throw new Error(`No available Artifacts repository name for ${input.name}`);

  try {
    await seedInitialCommit(created.name, created.remote, created.token, input);
    await upsertRepositories(integration, [
      {
        externalId: created.name,
        owner: input.owner,
        name: input.name,
        defaultBranch: created.defaultBranch,
      },
    ]);
    const repo = await getRepositoryByExternalId(integration.id, created.name);
    if (!repo) throw new Error('repository insert returned no row');
    return { repo, remote: created.remote };
  } catch (failure) {
    await env.GIT_ARTIFACTS.delete(created.name).catch((cleanupFailure) => {
      console.error('turbodiff: failed to clean up Artifacts repository', cleanupFailure);
    });
    throw failure;
  }
}

async function seedInitialCommit(
  artifactsRepo: string,
  remoteUrl: string,
  token: string,
  input: { owner: string; name: string; description?: string },
): Promise<void> {
  const remote = artifactsWorkspaceRemote(remoteUrl, token);
  const sandbox = runnerSandbox(`provision--${artifactsRepo}`.toLowerCase(), { sleepAfter: '5m' });
  const directory = `/workspace/provision-${artifactsRepo}`;
  const readme = `# ${input.name}\n\n${input.description?.trim() || 'A turbodiff project.'}\n`;
  const initialized = await sandbox.exec(
    `rm -rf ${directory} && mkdir -p ${directory} && cd ${directory} && git init -q -b main && ` +
      'git config user.name "turbodiff[bot]" && ' +
      'git config user.email "turbodiff[bot]@users.noreply.github.com"',
    { timeout: 5 * 60_000 },
  );
  if (!initialized.success) {
    throw new Error(`provisioning workspace init failed: ${initialized.stderr.slice(0, 500)}`);
  }
  await sandbox.writeFile(`${directory}/README.md`, readme);
  const pushed = await sandbox.exec(
    `cd ${directory} && git add -A && git commit -q -m "Initialize repository" && ` +
      `git ${remote.configFlags} push -q "${remote.authUrl}" main`,
    { env: remote.env, timeout: 2 * 60_000 },
  );
  if (!pushed.success) {
    throw new Error(`initial push failed: ${redactSecrets(pushed.stderr, [token]).slice(0, 500)}`);
  }
  await sandbox.exec(`rm -rf ${directory}`).catch(() => undefined);
}

export async function mintArtifactsCloneToken(
  repo: RepositoryRow,
  scope: 'read' | 'write',
  ttlSeconds: number,
): Promise<CloneCredential> {
  if (repo.source_provider !== 'artifacts' || !repo.external_id) {
    throw new Error(`${repo.owner}/${repo.name} is not an Artifacts-hosted repository`);
  }
  const handle = await env.GIT_ARTIFACTS.get(repo.external_id);
  const token = await handle.createToken(scope, ttlSeconds);
  return {
    remote: artifactsRemoteUrl(repo.external_id),
    token: token.plaintext,
    scope,
    expiresAt: token.expiresAt,
  };
}

export async function applyArtifactsEvent(event: ArtifactsEvent): Promise<string> {
  const repo = await getRepositoryByProviderExternalId('artifacts', event.repoName);
  if (isArtifactsPushedEvent(event)) {
    if (!repo) return `push to untracked repository ${event.repoName} ignored`;
    const branch = event.ref.replace(/^refs\/heads\//, '');
    if (/^0+$/.test(event.after)) await deleteRepositoryRef(repo.id, branch);
    else await recordRepositoryRef(repo.id, branch, event.after);
    return `recorded push to ${repo.owner}/${repo.name} (${event.ref})`;
  }
  if (event.type === ARTIFACTS_REPO_DELETED) {
    if (!repo) return `delete of untracked repository ${event.repoName} ignored`;
    await removeRepositories([repo.id]);
    return `removed repository row for ${repo.owner}/${repo.name}`;
  }
  return `no handler for ${event.type}`;
}
