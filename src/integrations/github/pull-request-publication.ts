import { GitHubApiError, githubJson } from './client.ts';

export interface PullRequestPublicationInput {
  owner: string;
  name: string;
  branch: string;
  base: string;
  title: string;
  summary: string;
  notes: string | null;
}

export interface PublishedPullRequest {
  number: number;
  url: string;
  state: 'open' | 'closed';
  headSha: string;
}

interface GithubPullRequestResponse {
  number: number;
  html_url: string;
  state: 'open' | 'closed';
  head: { ref: string; sha: string };
  base: { ref: string };
}

export interface PullRequestPublicationGateway {
  list(
    token: string,
    input: PullRequestPublicationInput,
  ): Promise<readonly GithubPullRequestResponse[]>;
  create(
    token: string,
    input: PullRequestPublicationInput,
    body: string,
  ): Promise<GithubPullRequestResponse>;
  branchHead(token: string, input: PullRequestPublicationInput): Promise<string | null>;
}

function pullRequestBody(input: PullRequestPublicationInput): string {
  return (
    input.summary +
    (input.notes
      ? `\n\n<details><summary>Implementation notes</summary>\n\n${input.notes}\n\n</details>`
      : '') +
    '\n\n---\n_turbodiff factory_'
  );
}

function normalizePullRequest(pullRequest: GithubPullRequestResponse): PublishedPullRequest {
  return {
    number: pullRequest.number,
    url: pullRequest.html_url,
    state: pullRequest.state,
    headSha: pullRequest.head.sha,
  };
}

const githubGateway: PullRequestPublicationGateway = {
  list: (token, input) => {
    const query = new URLSearchParams({
      state: 'all',
      head: `${input.owner}:${input.branch}`,
      base: input.base,
      per_page: '10',
    });
    return githubJson<GithubPullRequestResponse[]>(
      token,
      `/repos/${input.owner}/${input.name}/pulls?${query.toString()}`,
    );
  },
  create: (token, input, body) =>
    githubJson<GithubPullRequestResponse>(token, `/repos/${input.owner}/${input.name}/pulls`, {
      method: 'POST',
      body: JSON.stringify({
        title: input.title,
        head: input.branch,
        base: input.base,
        body,
      }),
    }),
  branchHead: async (token, input) => {
    try {
      const encodedRef = input.branch
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
      const ref = await githubJson<{ object: { sha: string } }>(
        token,
        `/repos/${input.owner}/${input.name}/git/ref/heads/${encodedRef}`,
      );
      return ref.object.sha;
    } catch (failure) {
      if (failure instanceof GitHubApiError && failure.status === 404) return null;
      throw failure;
    }
  },
};

async function findPublishedPullRequest(
  token: string,
  input: PullRequestPublicationInput,
  gateway: PullRequestPublicationGateway,
): Promise<PublishedPullRequest | null> {
  const matches = await gateway.list(token, input);
  const exact = matches.find(
    (pullRequest) => pullRequest.head.ref === input.branch && pullRequest.base.ref === input.base,
  );
  return exact ? normalizePullRequest(exact) : null;
}

async function createPullRequest(
  token: string,
  input: PullRequestPublicationInput,
  gateway: PullRequestPublicationGateway,
): Promise<PublishedPullRequest> {
  try {
    return normalizePullRequest(await gateway.create(token, input, pullRequestBody(input)));
  } catch (failure) {
    if (failure instanceof GitHubApiError && failure.status === 422) {
      const raced = await findPublishedPullRequest(token, input, gateway);
      if (raced) return raced;
    }
    throw failure;
  }
}

/** Publish a pull request after the caller has successfully pushed its branch. */
export async function publishGithubPullRequest(
  token: string,
  input: PullRequestPublicationInput,
  gateway: PullRequestPublicationGateway = githubGateway,
): Promise<PublishedPullRequest> {
  return (
    (await findPublishedPullRequest(token, input, gateway)) ??
    (await createPullRequest(token, input, gateway))
  );
}

/** Recover an external publication that may have committed before a Workflow retry. */
export async function recoverGithubPullRequest(
  token: string,
  input: PullRequestPublicationInput,
  gateway: PullRequestPublicationGateway = githubGateway,
): Promise<PublishedPullRequest | null> {
  const existing = await findPublishedPullRequest(token, input, gateway);
  if (existing) return existing;
  if (!(await gateway.branchHead(token, input))) return null;
  return createPullRequest(token, input, gateway);
}
