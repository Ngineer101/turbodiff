import type { Context } from 'hono';

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

export function deferredExecution(c: Context): DeferredExecution {
  try {
    return c.executionCtx;
  } catch {
    return fallbackExecution;
  }
}
