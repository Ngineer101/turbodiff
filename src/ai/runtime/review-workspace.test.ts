import { describe, expect, it } from 'vite-plus/test';
import { githubWorkspaceRemote } from '../../integrations/git/remotes.ts';
import {
  assertRepositorySearchPath,
  assertReviewHeadSha,
  reviewWorkspacePath,
  reviewWorkspaceSyncCommand,
} from './review-workspace-policy.ts';

describe('review workspace', () => {
  it('builds a credential-free worktree path and pull-ref sync', () => {
    const remote = githubWorkspaceRemote('acme/api', 'secret-token');
    const workDir = reviewWorkspacePath('review--acme--api--42');
    const command = reviewWorkspaceSyncCommand(workDir, remote);

    expect(workDir).toBe('/workspace/reviews/review--acme--api--42');
    expect(command).toContain('refs/pull/$PR_NUMBER/head');
    expect(command).toContain('$GIT_TOKEN');
    expect(command).not.toContain('secret-token');
    expect(command).not.toContain('remote add');
    expect(command).toContain('trap "rm -f');
  });

  it('rejects mutable refs and escaping search paths', () => {
    expect(assertReviewHeadSha('a'.repeat(40))).toBe('a'.repeat(40));
    expect(() => assertReviewHeadSha('main')).toThrow(/invalid review head SHA/);
    expect(assertRepositorySearchPath('src/ai')).toBe('src/ai');
    expect(() => assertRepositorySearchPath('../secret')).toThrow(/inside the repository/);
    expect(() => assertRepositorySearchPath('-n')).toThrow(/inside the repository/);
  });
});
