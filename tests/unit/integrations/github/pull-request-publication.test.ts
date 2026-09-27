import { describe, expect, it } from 'vite-plus/test';
import { GitHubApiError } from '../../../../src/integrations/github/client.ts';
import {
  publishGithubPullRequest,
  recoverGithubPullRequest,
  type PullRequestPublicationGateway,
  type PullRequestPublicationInput,
} from '../../../../src/integrations/github/pull-request-publication.ts';

const input: PullRequestPublicationInput = {
  owner: 'acme',
  name: 'widgets',
  branch: 'turbodiff/delivery-42-fix-widgets',
  base: 'main',
  title: 'Fix widgets',
  summary: '- Fixed widget scheduling',
  notes: 'Kept the existing queue contract.',
};

const published = {
  number: 73,
  html_url: 'https://github.com/acme/widgets/pull/73',
  state: 'open' as const,
  head: { ref: input.branch, sha: 'a'.repeat(40) },
  base: { ref: input.base },
};

function gateway(
  overrides: Partial<PullRequestPublicationGateway> = {},
): PullRequestPublicationGateway {
  return {
    list: async () => [],
    create: async () => published,
    branchHead: async () => null,
    ...overrides,
  };
}

describe('GitHub pull request publication', () => {
  it('reuses the pull request already committed by an interrupted attempt', async () => {
    let creates = 0;
    const result = await publishGithubPullRequest(
      'token',
      input,
      gateway({
        list: async () => [published],
        create: async () => {
          creates += 1;
          return published;
        },
      }),
    );

    expect(result).toEqual({
      number: 73,
      url: published.html_url,
      state: 'open',
      headSha: published.head.sha,
    });
    expect(creates).toBe(0);
  });

  it('publishes a pushed branch during recovery instead of rerunning generation', async () => {
    let createdBody = '';
    const result = await recoverGithubPullRequest(
      'token',
      input,
      gateway({
        branchHead: async () => published.head.sha,
        create: async (_token, _input, body) => {
          createdBody = body;
          return published;
        },
      }),
    );

    expect(result?.number).toBe(73);
    expect(createdBody).toContain(input.summary);
    expect(createdBody).toContain(input.notes);
  });

  it('recovers a concurrent create after GitHub reports the ambiguous 422 response', async () => {
    let lists = 0;
    const result = await publishGithubPullRequest(
      'token',
      input,
      gateway({
        list: async () => (++lists === 1 ? [] : [published]),
        create: async () => {
          throw new GitHubApiError(422, 'pull request already exists');
        },
      }),
    );

    expect(result.number).toBe(73);
    expect(lists).toBe(2);
  });

  it('returns no checkpoint when neither a pull request nor its branch exists', async () => {
    let creates = 0;
    const result = await recoverGithubPullRequest(
      'token',
      input,
      gateway({
        create: async () => {
          creates += 1;
          return published;
        },
      }),
    );

    expect(result).toBeNull();
    expect(creates).toBe(0);
  });
});
