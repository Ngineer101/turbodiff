import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { isJsonObject } from '../../shared/json.ts';
import { api } from './api.ts';

// Cheap live updates: poll the one-row change counter (GET
// /api/factory/version, maintained by PostgreSQL triggers) and refetch the real
// payloads only when it moves. Mounted once in AppShell — invalidation only
// refetches queries with active observers, so the cost of a bump is exactly
// the page being looked at. The per-query 30s intervals in queries.ts remain
// as a slow fallback; this hook is what makes changes land in seconds.
const FALLBACK_POLL_MS = 30_000;
// A socket that never opens is commonly an auth/proxy rejection. Five
// exponential attempts are enough to ride out a deploy without creating an
// endless request storm; the authenticated version poll remains the fallback.
const MAX_UNOPENED_ATTEMPTS = 5;

// Query keys that mirror live factory state.
const LIVE_KEYS = ['board', 'task', 'feature', 'chat', 'automation-runs', 'automation-run'];

export function useLiveRefresh(installationIds: number[]): void {
  const queryClient = useQueryClient();
  const idsKey = [...new Set(installationIds)].sort((a, b) => a - b).join(',');
  const [fullyConnected, setFullyConnected] = useState(false);
  const invalidate = useCallback(() => {
    for (const key of LIVE_KEYS) {
      void queryClient.invalidateQueries({ queryKey: [key] });
    }
  }, [queryClient]);

  useEffect(() => {
    const ids = idsKey.split(',').filter(Boolean).map(Number);
    if (ids.length === 0) return;
    let stopped = false;
    let connected = 0;
    const sockets = new Set<WebSocket>();
    const reconnectTimers = new Set<number>();
    const heartbeatTimers = new Map<WebSocket, number>();
    const updateConnectionState = () => setFullyConnected(connected === ids.length);

    const connect = (installationId: number, attempt: number) => {
      if (stopped) return;
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${protocol}//${location.host}/api/live/${installationId}`);
      sockets.add(socket);
      let opened = false;
      socket.addEventListener('open', () => {
        opened = true;
        connected += 1;
        updateConnectionState();
        const timer = window.setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send('{"type":"ping"}');
        }, 25_000);
        heartbeatTimers.set(socket, timer);
      });
      socket.addEventListener('message', (event) => {
        try {
          const message: unknown = JSON.parse(String(event.data));
          if (isJsonObject(message) && message.type === 'invalidate') invalidate();
        } catch {
          // Unknown hub messages do not invalidate data or break the socket.
        }
      });
      socket.addEventListener('close', () => {
        sockets.delete(socket);
        const heartbeat = heartbeatTimers.get(socket);
        if (heartbeat !== undefined) window.clearInterval(heartbeat);
        heartbeatTimers.delete(socket);
        if (opened) connected = Math.max(0, connected - 1);
        updateConnectionState();
        if (stopped) return;
        if (!opened && attempt >= MAX_UNOPENED_ATTEMPTS - 1) return;
        const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
        const timer = window.setTimeout(() => {
          reconnectTimers.delete(timer);
          connect(installationId, opened ? 0 : attempt + 1);
        }, delay);
        reconnectTimers.add(timer);
      });
    };

    for (const installationId of ids) connect(installationId, 0);
    return () => {
      stopped = true;
      setFullyConnected(false);
      for (const timer of reconnectTimers) window.clearTimeout(timer);
      for (const timer of heartbeatTimers.values()) window.clearInterval(timer);
      for (const socket of sockets) socket.close(1000, 'route closed');
    };
  }, [idsKey, invalidate]);

  // A deliberately slow global counter remains as a safety net during
  // deploys, offline transitions, or browsers where WebSockets are blocked.
  const { data } = useQuery({
    queryKey: ['factory-version'],
    queryFn: () => api.get<{ v: number }>('/api/factory/version'),
    enabled: !fullyConnected,
    refetchInterval: fullyConnected ? false : FALLBACK_POLL_MS,
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
      invalidate();
    }
    prev.current = v;
  }, [data?.v, invalidate]);
}
