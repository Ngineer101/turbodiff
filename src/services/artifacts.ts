import { env } from 'cloudflare:workers';
import { redactSecrets } from '../ai/runtime/redaction.ts';
import { runnerSandbox } from '../ai/runtime/sandbox.ts';
import {
  createArtifactsInstallation,
  createArtifactsRepository,
  getArtifactsInstallationByLogin,
  getRepoByArtifactsName,
  recordArtifactsPush,
  removeRepositories,
  type RepositoryRow,
} from '../data/db.ts';
import { artifactsWorkspaceRemote, deriveArtifactsRepoName } from '../integrations/git/provider.ts';
import {
  isArtifactsPushedEvent,
  ARTIFACTS_REPO_DELETED,
  type ArtifactsEvent,
} from '../shared/artifacts-events.ts';

// Artifacts-hosted project lifecycle (docs/artifacts-provider.md):
// provisioning (repo + synthetic tenancy + initial commit), user clone
// tokens, and event application for the ArtifactsEventsWorkflow.

// Same identifier grammar the GitHub routes accept for owner/name segments.
export const PROJECT_SEGMENT = /^[\w.-]{1,80}$/;

export interface CreatedProject {
  repo: RepositoryRow;
  remote: string;
}

function isArtifactsErrorWithCode<T>(err: T, code: string): boolean {
  return err instanceof Error && 'code' in err && err.code === code;
}

// Creates the Artifacts repo (retrying the derived name on collision), seeds
// an initial commit so every consumer has a base branch to clone, and only
// then records the D1 rows — a failed provisioning never leaves a repo row
// pointing at a broken remote. The Artifacts repo itself is compensated away
// on later failures.
export async function createArtifactsProject(input: {
  owner: string;
  name: string;
  description?: string;
}): Promise<CreatedProject> {
  if (!PROJECT_SEGMENT.test(input.owner) || !PROJECT_SEGMENT.test(input.name)) {
    throw new Error(`owner and name must match ${PROJECT_SEGMENT}`);
  }

  let created: Awaited<ReturnType<typeof env.GIT_ARTIFACTS.create>> | null = null;
  for (let attempt = 0; attempt < 3 && !created; attempt++) {
    const candidate = deriveArtifactsRepoName(input.owner, input.name, attempt);
    try {
      created = await env.GIT_ARTIFACTS.create(candidate, {
        description: input.description?.trim() || `turbodiff project ${input.owner}/${input.name}`,
      });
    } catch (err) {
      if (!isArtifactsErrorWithCode(err, 'ALREADY_EXISTS')) throw err;
    }
  }
  if (!created) {
    throw new Error(`an Artifacts repo already exists for every candidate name of ${input.name}`);
  }

  try {
    await seedInitialCommit(created.name, created.remote, created.token, input);
    const installation =
      (await getArtifactsInstallationByLogin(input.owner)) ??
      (await createArtifactsInstallation(input.owner));
    const repo = await createArtifactsRepository({
      installationId: installation.id,
      owner: input.owner,
      name: input.name,
      artifactsRepo: created.name,
      defaultBranch: created.defaultBranch,
    });
    return { repo, remote: created.remote };
  } catch (err) {
    // Compensate so a retry doesn't trip over a half-provisioned repo.
    await env.GIT_ARTIFACTS.delete(created.name).catch((cleanupErr) => {
      console.error(
        `turbodiff: failed to clean up artifacts repo ${created?.name} after provisioning error:`,
        cleanupErr,
      );
    });
    throw err;
  }
}

async function seedInitialCommit(
  artifactsRepo: string,
  remoteUrl: string,
  token: string,
  input: { owner: string; name: string; description?: string },
): Promise<void> {
  const remote = artifactsWorkspaceRemote(remoteUrl, token);
  const sandbox = runnerSandbox(`provision--${artifactsRepo}`.toLowerCase(), {
    sleepAfter: '5m',
  });
  const dir = `/workspace/provision-${artifactsRepo}`;
  const readme =
    `# ${input.name}\n\n` +
    `${input.description?.trim() || 'A turbodiff project.'}\n\n` +
    `Created by [turbodiff](https://turbodiff.dev); hosted on Cloudflare Artifacts.\n`;

  // First exec on a cold container pays the boot, hence the generous timeout.
  const init = await sandbox.exec(
    `rm -rf ${dir} && mkdir -p ${dir} && cd ${dir} && git init -q -b main && ` +
      `git config user.name "turbodiff[bot]" && ` +
      `git config user.email "turbodiff[bot]@users.noreply.github.com"`,
    { timeout: 5 * 60_000 },
  );
  if (!init.success) {
    throw new Error(`provisioning workspace init failed: ${init.stderr.slice(0, 500)}`);
  }
  await sandbox.writeFile(`${dir}/README.md`, readme);
  const push = await sandbox.exec(
    `cd ${dir} && git add -A && git commit -q -m "Initialize ${input.name}" && ` +
      `git ${remote.configFlags} push -q "${remote.authUrl}" main`,
    { env: remote.env, timeout: 2 * 60_000 },
  );
  if (!push.success) {
    throw new Error(
      `initial commit push failed: ${redactSecrets(push.stderr, [token]).slice(0, 500)}`,
    );
  }
  await sandbox.exec(`rm -rf ${dir}`).catch(() => {});
}

export interface CloneCredential {
  remote: string;
  token: string;
  scope: 'read' | 'write';
  expiresAt: string;
}

// A user-facing clone credential: the "deploy key" replacement that lets
// anyone with access clone their turbodiff-hosted repo with plain git.
export async function mintArtifactsCloneToken(
  repo: RepositoryRow,
  scope: 'read' | 'write',
  ttlSeconds: number,
): Promise<CloneCredential> {
  if (repo.provider !== 'artifacts' || !repo.artifacts_repo) {
    throw new Error(`${repo.owner}/${repo.name} is not an Artifacts-hosted repo`);
  }
  const handle = await env.GIT_ARTIFACTS.get(repo.artifacts_repo);
  const token = await handle.createToken(scope, ttlSeconds);
  return { remote: handle.remote, token: token.plaintext, scope, expiresAt: token.expiresAt };
}

// Applies one Artifacts event to D1. Runs inside the ArtifactsEventsWorkflow;
// must stay idempotent (workflow steps can be retried).
export async function applyArtifactsEvent(event: ArtifactsEvent): Promise<string> {
  if (isArtifactsPushedEvent(event)) {
    const row = await recordArtifactsPush(
      event.repoName,
      event.eventTimestamp ?? new Date().toISOString(),
    );
    if (!row) return `push to untracked repo ${event.repoName} ignored`;
    return `recorded push to ${row.owner}/${row.name} (${event.ref})`;
  }
  if (event.type === ARTIFACTS_REPO_DELETED) {
    const row = await getRepoByArtifactsName(event.repoName);
    if (!row || row.provider !== 'artifacts') return `delete of untracked repo ${event.repoName}`;
    // The hosted repo is gone (operator delete); drop the stale row so the
    // dashboard and factory stop offering it.
    await removeRepositories([row.id]);
    return `removed repository row for deleted repo ${row.owner}/${row.name}`;
  }
  return `no handler for ${event.type}`;
}
