import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { api } from './api.ts';

// Cheap live updates: poll the one-row change counter (GET
// /api/factory/version, maintained by D1 triggers) and refetch the real
// payloads only when it moves. Mounted once in AppShell — invalidation only
// refetches queries with active observers, so the cost of a bump is exactly
// the page being looked at. The per-query 30s intervals in queries.ts remain
// as a slow fallback; this hook is what makes changes land in seconds.
const VERSION_POLL_MS = 4_000;

// Query keys that mirror live factory state.
const LIVE_KEYS = ['board', 'task', 'feature', 'chat', 'automation-runs', 'automation-run'];

export function useLiveRefresh(): void {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ['factory-version'],
    queryFn: () => api.get<{ v: number }>('/api/factory/version'),
    refetchInterval: VERSION_POLL_MS,
    // Version numbers are meaningless across reloads — never persist, and
    // don't let a cached value suppress the first real read.
    gcTime: 0,
    staleTime: 0,
  });
  const prev = useRef<number | null>(null);
  useEffect(() => {
    const v = data?.v;
    if (v === undefined) return;
    if (prev.current !== null && v !== prev.current) {
      for (const key of LIVE_KEYS) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
    }
    prev.current = v;
  }, [data?.v, queryClient]);
}
