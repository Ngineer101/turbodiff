// Thin fetch wrapper for the Worker's /api routes. Session-cookie authed:
// a 401 means the cookie is missing/expired, so restart OAuth.

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// Conditional-GET memory: last etag + parsed payload per path. A refetch
// whose body hasn't changed comes back 304 with no body, and the cached
// payload is returned without re-download or re-parse. Bounded — oldest
// entries fall out first.
const ETAG_CACHE_MAX = 50;
const etagCache = new Map<string, { etag: string; data: unknown }>();

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const baseHeaders: Record<string, string> = init?.body
    ? { accept: 'application/json', 'content-type': 'application/json' }
    : { accept: 'application/json' };
  const isGet = init?.method === undefined;
  const cached = isGet ? etagCache.get(path) : undefined;
  if (cached) baseHeaders['if-none-match'] = cached.etag;
  const res = await fetch(path, {
    ...init,
    headers: { ...baseHeaders, ...init?.headers },
  });
  if (res.status === 401) {
    window.location.href = '/auth/login';
    throw new ApiError('signed out', 401);
  }
  if (res.status === 304 && cached) {
    // SAFETY: a 304 certifies the body is byte-identical to what produced the
    // cached etag, so the stored payload is exactly the T this GET returns.
    return cached.data as T;
  }
  // SAFETY: the Worker's /api routes respond with JSON matching the caller-declared T and put
  // an `error` string on failure bodies; null stands in for empty or non-JSON bodies.
  const data = (await res.json().catch(() => null)) as ({ error?: string } & T) | null;
  if (!res.ok) throw new ApiError(data?.error ?? `request failed (${res.status})`, res.status);
  const etag = res.headers.get('etag');
  if (isGet && etag && data !== null) {
    etagCache.delete(path);
    etagCache.set(path, { etag, data });
    if (etagCache.size > ETAG_CACHE_MAX) {
      // SAFETY: size > 0, so the iterator yields a first key.
      etagCache.delete(etagCache.keys().next().value as string);
    }
  }
  // SAFETY: ok /api responses carry a body matching T; null only occurs for endpoints whose
  // callers never read the body.
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T = { ok: boolean }, B = never>(path: string, body?: B) =>
    request<T>(path, {
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  put: <T = { ok: boolean }, B = never>(path: string, body: B) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  patch: <T = { ok: boolean }, B = never>(path: string, body: B) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: <T = { ok: boolean }>(path: string) => request<T>(path, { method: 'DELETE' }),
};
