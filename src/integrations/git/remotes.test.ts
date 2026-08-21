import { describe, expect, it } from 'vite-plus/test';
import {
  artifactsWorkspaceRemote,
  deriveArtifactsRepoName,
  factoryUnsupportedReason,
  githubWorkspaceRemote,
} from './remotes.ts';

describe('githubWorkspaceRemote', () => {
  it('keeps the historical command shape with the token only in env', () => {
    const remote = githubWorkspaceRemote('acme/api', 'tok-123');
    expect(remote.authUrl).toBe('https://x-access-token:$GIT_TOKEN@github.com/acme/api.git');
    expect(remote.cleanUrl).toBe('https://github.com/acme/api.git');
    expect(remote.configFlags).toBe('');
    expect(remote.env).toEqual({ GIT_TOKEN: 'tok-123' });
    // The credential must never appear in a command-embeddable field.
    expect(remote.authUrl).not.toContain('tok-123');
  });
});

describe('artifactsWorkspaceRemote', () => {
  it('routes auth through a header and keeps the URL credential-free', () => {
    const remote = artifactsWorkspaceRemote(
      'https://acct.artifacts.cloudflare.net/git/turbodiff-repos/acme--api.git',
      'art_v1_secret?expires=1760000000',
    );
    expect(remote.authUrl).toBe('$GIT_REMOTE');
    expect(remote.cleanUrl).toContain('acme--api.git');
    expect(remote.configFlags).toContain('Authorization: Bearer $GIT_TOKEN');
    expect(remote.env.GIT_TOKEN).toBe('art_v1_secret?expires=1760000000');
    expect(remote.env.GIT_REMOTE).toBe(remote.cleanUrl);
    expect(remote.configFlags).not.toContain('art_v1_secret');
  });
});

describe('deriveArtifactsRepoName', () => {
  it('joins owner and name with a double dash', () => {
    expect(deriveArtifactsRepoName('acme', 'api')).toBe('acme--api');
  });

  it('sanitizes characters outside the Artifacts grammar', () => {
    expect(deriveArtifactsRepoName('acme co', 'my repo!')).toBe('acme-co--my-repo');
  });

  it('never emits a leading separator', () => {
    expect(deriveArtifactsRepoName('-acme', 'api')).toMatch(/^[A-Za-z0-9]/);
  });

  it('caps length at 64 including collision suffixes', () => {
    const long = 'a'.repeat(80);
    expect(deriveArtifactsRepoName(long, long).length).toBeLessThanOrEqual(64);
    const suffixed = deriveArtifactsRepoName(long, long, 3);
    expect(suffixed.length).toBeLessThanOrEqual(64);
    expect(suffixed.endsWith('-4')).toBe(true);
  });

  it('adds a numeric suffix per collision attempt', () => {
    expect(deriveArtifactsRepoName('acme', 'api', 1)).toBe('acme--api-2');
  });
});

describe('factoryUnsupportedReason', () => {
  it('passes GitHub repos through', () => {
    expect(factoryUnsupportedReason({ provider: 'github', owner: 'a', name: 'b' })).toBeNull();
  });

  it('names the repo when rejecting an Artifacts repo', () => {
    const reason = factoryUnsupportedReason({ provider: 'artifacts', owner: 'acme', name: 'api' });
    expect(reason).toContain('acme/api');
    expect(reason).toContain('Phase 2');
  });
});
