// Thin fetch wrapper for the Worker's /api routes. Recoverable GitHub account
// states are 200 responses on /api/me; a 401 now means the application session
// itself is missing/expired.

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

let redirectingToLogin = false;

function restartAuthentication(): void {
  if (redirectingToLogin) return;
  redirectingToLogin = true;
  // Never hydrate a new/renewed session with another user's account-scoped
  // payloads. Sidebar preferences use separate keys and remain intact.
  window.localStorage.removeItem('turbodiff.queryCache');
  window.location.replace('/auth/login?expired=1');
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has('accept')) headers.set('accept', 'application/json');
  if (init?.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const res = await fetch(path, {
    ...init,
    headers,
  });
  if (res.status === 401) {
    restartAuthentication();
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
