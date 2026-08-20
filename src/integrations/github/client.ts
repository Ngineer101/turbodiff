import type { JsonValue } from '../../shared/json.ts';

const API = 'https://api.github.com';

function apiUrl(pathOrUrl: string): string {
  if (pathOrUrl.startsWith('/')) return `${API}${pathOrUrl}`;
  const url = new URL(pathOrUrl);
  if (url.origin !== API) {
    throw new Error(`refusing GitHub API request to unexpected origin: ${url.origin}`);
  }
  return url.href;
}

// Shared authenticated GitHub REST adapter. Domain/services and AI tools use
// this protocol boundary instead of depending on one another.
export async function githubRequest(
  token: string,
  pathOrUrl: string,
  init?: RequestInit & { accept?: string },
): Promise<Response> {
  const { accept, ...requestInit } = init ?? {};
  const headers = new Headers({
    accept: accept ?? 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'user-agent': 'turbodiff',
    'x-github-api-version': '2022-11-28',
  });
  if (requestInit.body) headers.set('content-type', 'application/json');
  const response = await fetch(apiUrl(pathOrUrl), { ...requestInit, headers });
  if (!response.ok) {
    throw new Error(
      `GitHub API ${response.status} on ${pathOrUrl}: ${(await response.text()).slice(0, 500)}`,
    );
  }
  return response;
}

export async function githubJson<T>(
  token: string,
  pathOrUrl: string,
  init?: RequestInit & { accept?: string },
): Promise<T> {
  const response = await githubRequest(token, pathOrUrl, init);
  // SAFETY: callers provide the documented success shape for the selected
  // GitHub endpoint; githubRequest has already rejected non-2xx responses.
  return response.json() as Promise<T>;
}

function nextPage(response: Response): string | null {
  const match = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get('link') ?? '');
  return match?.[1] ?? null;
}

export async function githubPaginate<Page, Item>(
  token: string,
  path: string,
  items: (page: Page) => readonly Item[],
  options: { maxPages?: number } = {},
): Promise<Item[]> {
  const all: Item[] = [];
  const maxPages = options.maxPages ?? 100;
  let next: string | null = path;
  for (let pageNumber = 1; next && pageNumber <= maxPages; pageNumber++) {
    const response: Response = await githubRequest(token, next);
    // SAFETY: callers supply the documented page shape and the selector that
    // extracts items from that same endpoint response.
    const page = (await response.json()) as Page;
    all.push(...items(page));
    next = nextPage(response);
  }
  if (next) throw new Error(`GitHub pagination exceeded ${maxPages} pages for ${path}`);
  return all;
}

export async function githubGraphql<T>(
  token: string,
  query: string,
  variables: Record<string, JsonValue>,
): Promise<T> {
  const response = await fetch(`${API}/graphql`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': 'turbodiff-pr-reviewer',
    },
    body: JSON.stringify({ query, variables }),
  });
  const payload = await response.json<{ data?: T; errors?: { message: string }[] }>();
  if (!response.ok || payload.errors?.length || !payload.data) {
    const detail =
      payload.errors?.map((error) => error.message).join('; ') ?? `HTTP ${response.status}`;
    throw new Error(`GitHub GraphQL error: ${detail.slice(0, 500)}`);
  }
  return payload.data;
}
