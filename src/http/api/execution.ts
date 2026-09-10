import type { Context } from 'hono';
import type { ApiEnv } from '../api-support.ts';

export interface DeferredExecution {
  waitUntil(promise: Promise<void>): void;
}

const fallbackExecution: DeferredExecution = {
  waitUntil(promise) {
    // Hono's direct-request test harness has no Worker ExecutionContext.
    // The operation has already started; consume a background rejection so
    // response semantics remain the same as production waitUntil.
    void promise.catch(() => {});
  },
};

export function deferredExecution(c: Context<ApiEnv>): DeferredExecution {
  try {
    return c.executionCtx;
  } catch {
    return fallbackExecution;
  }
}

export async function immutableRepoJson<T>(
  executionCtx: DeferredExecution,
  cacheKey: string | null,
  load: () => Promise<T>,
): Promise<T> {
  if (!cacheKey) return load();
  const request = new Request(`https://repo-read-cache.turbodiff.internal/${cacheKey}`);
  try {
    const cached = await caches.default.match(request);
    if (cached) return cached.json<T>();
  } catch {
    // Cache API is best-effort (and absent in some unit harnesses).
  }
  const value = await load();
  try {
    executionCtx.waitUntil(
      caches.default
        .put(
          request,
          Response.json(value, {
            headers: { 'cache-control': 'public, max-age=31536000, immutable' },
          }),
        )
        .catch(() => {}),
    );
  } catch {
    // The read result remains valid when the edge cache is unavailable.
  }
  return value;
}
