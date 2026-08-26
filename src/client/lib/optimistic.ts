import type { QueryClient, QueryKey } from '@tanstack/react-query';

// Shared optimistic-mutation plumbing: apply the expected outcome to the
// cached query the moment the user acts, and let the server round-trip
// reconcile in the background. Callers wire this as onMutate, call
// `ctx.rollback()` in onError, and keep their onSettled invalidation as the
// eventual-consistency pass (it re-syncs the cache without the UI waiting).
export async function applyOptimistic<T>(
  queryClient: QueryClient,
  key: QueryKey,
  patch: (prev: T) => T,
): Promise<{ rollback: () => void }> {
  // Stop an in-flight refetch from overwriting the optimistic write.
  await queryClient.cancelQueries({ queryKey: key });
  const prev = queryClient.getQueryData<T>(key);
  if (prev !== undefined) queryClient.setQueryData<T>(key, patch(prev));
  return {
    rollback: () => {
      if (prev !== undefined) queryClient.setQueryData(key, prev);
    },
  };
}

// D1-style UTC timestamp ('YYYY-MM-DD HH:MM:SS') for optimistic rows, so
// they format identically to server rows (see format.ts ago()).
export function optimisticNow(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

// Client-only placeholder id for an optimistic row: negative, so it can
// never collide with a server id, and unique enough within one session.
let optimisticSeq = 0;
export function optimisticId(): number {
  optimisticSeq += 1;
  return -(Date.now() + optimisticSeq);
}
