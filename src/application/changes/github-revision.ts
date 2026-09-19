import { changeRevisionArtifactSchema } from '../../artifacts/change.ts';
import { createChangeRevision, latestChangeRevision, type ChangeRow } from '../../data/changes.ts';
import type { RepositoryRow } from '../../data/repositories.ts';
import { buildReviewDiffSnapshot } from '../../domain/review-context.ts';
import { installationToken } from '../../integrations/github/app.ts';
import { githubJson, githubRequest } from '../../integrations/github/client.ts';
import { persistJsonArtifact } from '../artifacts.ts';

interface GithubPullRequest {
  title: string;
  body: string | null;
  base: { ref: string; sha: string };
  head: { ref: string; sha: string };
}

export async function syncGithubChangeRevision(
  repository: RepositoryRow,
  change: ChangeRow,
  expectedHeadSha?: string,
) {
  if (repository.source_provider !== 'github' || !change.number) {
    throw new Error('change is not a GitHub pull request');
  }
  const installationId = Number(repository.source_external_account_id);
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    throw new Error('GitHub repository has no installation');
  }
  const token = await installationToken(installationId);
  const path = `/repos/${repository.owner}/${repository.name}/pulls/${change.number}`;
  const pullRequest = await githubJson<GithubPullRequest>(token, path);
  if (expectedHeadSha && pullRequest.head.sha !== expectedHeadSha) {
    throw new Error('pull request changed while its revision was being captured');
  }
  const existing = await latestChangeRevision(change.id);
  if (existing?.head_sha === pullRequest.head.sha) return existing;
  const patch = await githubRequest(token, path, { accept: 'application/vnd.github.v3.diff' }).then(
    (response) => response.text(),
  );
  const after = await githubJson<GithubPullRequest>(token, path);
  if (after.head.sha !== pullRequest.head.sha || after.base.sha !== pullRequest.base.sha) {
    throw new Error('pull request changed while its diff was being captured');
  }
  const snapshot = buildReviewDiffSnapshot(patch);
  const artifact = await persistJsonArtifact({
    organizationId: change.organization_id,
    kind: 'change_revision',
    storageKey:
      `organizations/${change.organization_id}/changes/${change.id}` +
      `/revisions/${pullRequest.head.sha}.json`,
    schema: changeRevisionArtifactSchema,
    value: {
      kind: 'change-revision',
      title: pullRequest.title,
      description: pullRequest.body ?? '',
      base: pullRequest.base.ref,
      head: pullRequest.head.ref,
      baseSha: pullRequest.base.sha,
      headSha: pullRequest.head.sha,
      files: snapshot.files,
      patch: snapshot.diff,
    },
  });
  return createChangeRevision({
    change,
    baseSha: pullRequest.base.sha,
    headSha: pullRequest.head.sha,
    artifactId: artifact.id,
  });
}
