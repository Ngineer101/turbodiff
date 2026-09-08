import type { Sandbox } from '@cloudflare/sandbox';
import type { RepositoryRow } from '../../data/db.ts';
import { resolveWorkspaceRemote, remoteSourceOf } from '../../integrations/git/provider.ts';
import { redactSecrets } from './redaction.ts';
import { reviewSandbox } from './sandbox.ts';
import {
  assertReviewHeadSha,
  reviewWorkspacePath,
  reviewWorkspaceSyncCommand,
} from './review-workspace-policy.ts';

export interface ReviewWorkspace {
  sandbox: Sandbox;
  workDir: string;
  scrub(text: string): string;
}

export async function prepareReviewWorkspace(
  repo: RepositoryRow,
  prNumber: number,
  headSha: string,
  agentInstanceId: string,
): Promise<ReviewWorkspace> {
  if (repo.provider !== 'github') {
    throw new Error('hosted review workspaces currently require a GitHub pull request');
  }
  const expectedHead = assertReviewHeadSha(headSha);
  const workDir = reviewWorkspacePath(agentInstanceId);
  const sandbox = reviewSandbox(repo);
  const remote = await resolveWorkspaceRemote(remoteSourceOf(repo), 'read');
  const scrub = (text: string) => redactSecrets(text, [remote.token]);
  const result = await sandbox.exec(reviewWorkspaceSyncCommand(workDir, remote), {
    env: { ...remote.env, EXPECTED_HEAD: expectedHead, PR_NUMBER: String(prNumber) },
    timeout: 3 * 60_000,
  });
  if (!result.success) {
    throw new Error(
      `review workspace sync failed: ${scrub(`${result.stdout}\n${result.stderr}`).trim().slice(-500)}`,
    );
  }
  return { sandbox, workDir, scrub };
}
