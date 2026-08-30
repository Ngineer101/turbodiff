import type { JsonValue } from '../../shared/json.ts';

const API = 'https://api.github.com';

export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

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
  init?: RequestInit & { accept?: string; allow304?: boolean },
): Promise<Response> {
  const { accept, allow304, ...requestInit } = init ?? {};
  const headers = new Headers({
    accept: accept ?? 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'user-agent': 'turbodiff',
    'x-github-api-version': '2022-11-28',
  });
  // Caller headers ride on top of the defaults (conditional-request etags).
  for (const [name, value] of new Headers(requestInit.headers ?? {})) {
    headers.set(name, value);
  }
  if (requestInit.body) headers.set('content-type', 'application/json');
  const response = await fetch(apiUrl(pathOrUrl), { ...requestInit, headers });
  // 304 is a success for conditional requests, not an error.
  if (!response.ok && !(allow304 && response.status === 304)) {
    throw new GitHubApiError(
      response.status,
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

// Per-isolate conditional-request memory for githubJsonCached. Bounded;
// oldest entries fall out first.
const GITHUB_ETAG_MAX = 100;
const githubEtagCache = new Map<string, { etag: string; data: unknown }>();

// githubJson with If-None-Match: GitHub answers 304 when the resource is
// unchanged, which costs no rate-limit credit and no body transfer — built
// for the cockpit's polled PR reads, which are usually identical between
// polls. Cache is per-isolate; a cold isolate just pays one full read.
export async function githubJsonCached<T>(token: string, pathOrUrl: string): Promise<T> {
  const cached = githubEtagCache.get(pathOrUrl);
  const response = await githubRequest(token, pathOrUrl, {
    headers: cached ? { 'if-none-match': cached.etag } : undefined,
    allow304: true,
  });
  if (response.status === 304 && cached) {
    // SAFETY: a 304 certifies the resource matches the cached etag, so the
    // stored payload is the same T a fresh read would produce.
    return cached.data as T;
  }
  // SAFETY: as in githubJson — documented success shape, non-2xx rejected.
  const data = (await response.json()) as T;
  const etag = response.headers.get('etag');
  if (etag) {
    githubEtagCache.delete(pathOrUrl);
    githubEtagCache.set(pathOrUrl, { etag, data });
    if (githubEtagCache.size > GITHUB_ETAG_MAX) {
      // SAFETY: size > 0, so the iterator yields a first key.
      githubEtagCache.delete(githubEtagCache.keys().next().value as string);
    }
  }
  return data;
}

function nextPage(response: Response): string | null {
  const match = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get('link') ?? '');
  return match?.[1] ?? null;
}

// Follows rel="next" links, failing loudly (never truncating) past maxPages.
// Callers that must reconcile a complete listing pass maxPages: Infinity to
// paginate to exhaustion instead.
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
