import type { ChangeRow } from '../../data/changes.ts';
import type { RepositoryRow } from '../../data/repositories.ts';
import { installationToken } from './app.ts';
import { githubJson } from './client.ts';

// Recheck provider state immediately before starting work and before pushing:
// webhooks can lag behind a user closing or merging a pull request.
export async function assertChangeWritable(repository: RepositoryRow, change: ChangeRow) {
  if (repository.source_provider !== 'github') return;
  if (!change.number) throw new Error('Change has no GitHub pull request');
  const pull = await githubJson<{
    state: string;
    merged: boolean;
    head: { ref: string; repo: { full_name: string } | null };
  }>(
    await installationToken(Number(repository.source_external_account_id)),
    `/repos/${repository.owner}/${repository.name}/pulls/${change.number}`,
  );
  if (pull.state !== 'open' || pull.merged) throw new Error('The pull request is no longer open');
  if (
    pull.head.ref !== change.source_ref ||
    pull.head.repo?.full_name.toLowerCase() !==
      `${repository.owner}/${repository.name}`.toLowerCase()
  )
    throw new Error('The pull request source branch has changed');
}
