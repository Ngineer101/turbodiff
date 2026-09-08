import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { cacheSyncCommand, worktreeCloneCommand } from './repository-workspace.ts';
import type { WorkspaceRemote } from '../../integrations/git/remotes.ts';

// Runs the exact shell the sandbox would run, against a real git remote on
// disk. The sequence under test is the one production hits: a cold
// container bootstraps the cache for a verification (the PR branch), the
// next verification warm-syncs the same branch, and so does the one after.
const sh = (script: string, env: Record<string, string>) =>
  execFileSync('bash', ['-euo', 'pipefail', '-c', script], {
    env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    .toString()
    .trim();

describe('cache sync shell against a real git remote', () => {
  let root: string;
  let origin: string;
  let remote: WorkspaceRemote;
  const cacheDir = () => join(root, 'cache');
  const commit = (message: string) => {
    sh(
      `cd "$ORIGIN" && echo "${message}" >> notes.txt && git add notes.txt && git commit -q -m "${message}"`,
      {
        ORIGIN: origin,
      },
    );
    return git(origin, 'rev-parse', 'HEAD');
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'turbodiff-cache-'));
    origin = join(root, 'origin');
    sh(
      `git init -q -b main "$ORIGIN" && cd "$ORIGIN" && git config user.email t@t && git config user.name t && ` +
        `git config receive.denyCurrentBranch ignore && echo base > notes.txt && git add notes.txt && git commit -q -m base && ` +
        `git checkout -q -b turbodiff/feat-7 && echo feat > feat.txt && git add feat.txt && git commit -q -m feat`,
      { ORIGIN: origin },
    );
    remote = {
      provider: 'github',
      authUrl: '$GIT_REMOTE',
      cleanUrl: origin,
      configFlags: '',
      env: { GIT_REMOTE: origin },
      token: '',
    };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('warm-syncs the branch a cold bootstrap checked out, run after run', () => {
    const env = { ...remote.env, BASE_REF: 'turbodiff/feat-7' };
    const sync = cacheSyncCommand({ cacheDir: cacheDir(), remote });

    sh(sync, env); // cold: clone --branch turbodiff/feat-7
    expect(git(cacheDir(), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
    const first = git(cacheDir(), 'rev-parse', 'refs/heads/turbodiff/feat-7');

    const pushed = commit('fix from the repair agent');
    sh(sync, env); // warm: the fetch that production refused
    expect(git(cacheDir(), 'rev-parse', 'refs/heads/turbodiff/feat-7')).toBe(pushed);
    expect(first).not.toBe(pushed);
    sh(sync, env); // and again, with nothing new
    expect(git(cacheDir(), 'rev-parse', 'refs/heads/turbodiff/feat-7')).toBe(pushed);

    // The verification worktree comes off the refreshed ref.
    const workDir = join(root, 'work');
    sh(worktreeCloneCommand({ cacheDir: cacheDir(), workDir }), {
      WORK_BRANCH: 'turbodiff/feat-7',
    });
    expect(git(workDir, 'rev-parse', 'HEAD')).toBe(pushed);
    expect(git(workDir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('turbodiff/feat-7');
  });

  it('is the checkout, not the fetch, that git refuses — the condition the detach removes', () => {
    // The pre-fix cache state: the branch checked out (clone --branch, no detach).
    sh(`git clone -q --depth 50 --single-branch --branch turbodiff/feat-7 "$GIT_REMOTE" "$CACHE"`, {
      ...remote.env,
      CACHE: cacheDir(),
    });
    commit('another push');
    let stderr = '';
    try {
      sh(
        `git -C "$CACHE" fetch "$GIT_REMOTE" "+refs/heads/turbodiff/feat-7:refs/heads/turbodiff/feat-7"`,
        { ...remote.env, CACHE: cacheDir() },
      );
    } catch (err) {
      // SAFETY: execFileSync rejects with a child-process error that carries
      // the captured stderr; nothing else throws inside sh().
      stderr = String((err as { stderr?: Buffer | string }).stderr ?? '');
    }
    expect(stderr).toMatch(/[Rr]efus(ing|ed) to fetch into (current )?branch/);
  });

  it('keeps the generation path: fetch base and check it out as the cache branch', () => {
    const env = { ...remote.env, BASE_REF: 'main' };
    const sync = cacheSyncCommand({ cacheDir: cacheDir(), remote, branch: 'turbodiff/feat-8' });
    sh(sync, env); // cold
    sh(sync, env); // warm: checkout -B main FETCH_HEAD
    expect(git(cacheDir(), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    const workDir = join(root, 'work');
    sh(worktreeCloneCommand({ cacheDir: cacheDir(), workDir, branch: 'turbodiff/feat-8' }), {
      WORK_BRANCH: 'turbodiff/feat-8',
    });
    expect(git(workDir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('turbodiff/feat-8');
  });
});
