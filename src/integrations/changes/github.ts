import type { ChangeRow } from '../../data/changes.ts';
import type { RepositoryRow } from '../../data/repositories.ts';
import { installationToken } from '../github/app.ts';
import { githubRequest } from '../github/client.ts';

function installationId(repository: RepositoryRow): number {
  const id = Number(repository.source_external_account_id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid GitHub installation id');
  return id;
}

function pullRequestNumber(change: ChangeRow): number {
  if (!change.number) throw new Error('Change has no pull request number');
  return change.number;
}

export async function mergeGithubChange(
  repository: RepositoryRow,
  change: ChangeRow,
): Promise<void> {
  const token = await installationToken(installationId(repository));
  const response = await githubRequest(
    token,
    `/repos/${repository.owner}/${repository.name}/pulls/${pullRequestNumber(change)}/merge`,
    { method: 'PUT', body: JSON.stringify({ merge_method: 'merge' }) },
  );
  const result = await response.json<{ merged?: boolean }>();
  if (!result.merged) throw new Error('GitHub did not merge the pull request');
}

export async function closeGithubChange(
  repository: RepositoryRow,
  change: ChangeRow,
): Promise<{ branchDeleted: boolean }> {
  const token = await installationToken(installationId(repository));
  const root = `/repos/${repository.owner}/${repository.name}`;
  await githubRequest(token, `${root}/pulls/${pullRequestNumber(change)}`, {
    method: 'PATCH',
    body: JSON.stringify({ state: 'closed' }),
  });
  const ref = change.source_ref
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  const branchDeleted = await githubRequest(token, `${root}/git/refs/heads/${ref}`, {
    method: 'DELETE',
  })
    .then(() => true)
    .catch(() => false);
  return { branchDeleted };
}
