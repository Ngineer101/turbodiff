// Thin fetch wrapper for the Worker's /api routes. Session-cookie authed:
// a 401 means the cookie is missing/expired, so restart OAuth.

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const baseHeaders: Record<string, string> = init?.body
    ? { accept: 'application/json', 'content-type': 'application/json' }
    : { accept: 'application/json' };
  const res = await fetch(path, {
    ...init,
    headers: { ...baseHeaders, ...init?.headers },
  });
  if (res.status === 401) {
    window.location.href = '/auth/login';
    throw new ApiError('signed out', 401);
  }
  // SAFETY: the Worker's /api routes respond with JSON matching the caller-declared T and put
  // an `error` string on failure bodies; null stands in for empty or non-JSON bodies.
  const data = (await res.json().catch(() => null)) as ({ error?: string } & T) | null;
  if (!res.ok) throw new ApiError(data?.error ?? `request failed (${res.status})`, res.status);
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
