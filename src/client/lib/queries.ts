import { QueryClient, queryOptions } from '@tanstack/react-query';
import { api } from './api.ts';
import type {
  ApiAgentDetail,
  ApiAgentsList,
  ApiBoard,
  ApiFeatureDetail,
  ApiIntegrations,
  ApiMe,
  ApiPlan,
  ApiRunnerCredentialsList,
  ApiSettings,
  ApiUsage,
} from '../../shared/api-types.ts';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});

// Poll cadence while an agent is working — instead of full-page reloads.
export const LIVE_POLL_MS = 5_000;

const RUNNING_PLAN_STATUSES = new Set(['analyzing', 'refining']);

// Feature states where generation stopped without a PR — terminal until the
// user retries.
export const GENERATION_STOPPED = new Set(['failed', 'checks_failed', 'no_changes']);

export function taskIsLive(p: ApiPlan): boolean {
  if (RUNNING_PLAN_STATUSES.has(p.status)) return true;
  if (p.repos.some((r) => r.verification?.status === 'running')) return true;
  // Approved and some repo has no PR yet: that repo's generation is in
  // flight unless it stopped.
  return (
    p.status === 'approved' &&
    p.repos.some((r) => !r.pr_number && !GENERATION_STOPPED.has(r.feature_status ?? ''))
  );
}

export const meQuery = queryOptions({
  queryKey: ['me'],
  queryFn: () => api.get<ApiMe>('/api/me'),
  staleTime: Infinity,
});

export const boardQuery = queryOptions({
  queryKey: ['board'],
  queryFn: () => api.get<ApiBoard>('/api/board'),
  refetchInterval: (query) => (query.state.data?.tasks.some(taskIsLive) ? LIVE_POLL_MS : false),
});

export const taskQuery = (id: number) =>
  queryOptions({
    queryKey: ['task', id],
    queryFn: () => api.get<ApiPlan>(`/api/tasks/${id}`),
    refetchInterval: (query) =>
      query.state.data && taskIsLive(query.state.data) ? LIVE_POLL_MS : false,
  });

export const usageQuery = queryOptions({
  queryKey: ['usage'],
  queryFn: () => api.get<ApiUsage>('/api/usage'),
});

export const featureQuery = (id: number) =>
  queryOptions({
    queryKey: ['feature', id],
    queryFn: () => api.get<ApiFeatureDetail>(`/api/factory/features/${id}`),
    refetchInterval: (query) => {
      const d = query.state.data;
      if (!d) return false;
      // Poll while generation is in flight (no PR yet, not stopped) or a
      // verification run is live.
      if (!d.pr && !GENERATION_STOPPED.has(d.feature.status)) return LIVE_POLL_MS;
      return d.verification?.status === 'running' ? LIVE_POLL_MS : false;
    },
  });

export const agentsQuery = queryOptions({
  queryKey: ['agents'],
  queryFn: () => api.get<ApiAgentsList>('/api/agents'),
});

export const agentQuery = (id: number) =>
  queryOptions({
    queryKey: ['agent', id],
    queryFn: () => api.get<ApiAgentDetail>(`/api/agents/${id}`),
  });

export const settingsQuery = queryOptions({
  queryKey: ['settings'],
  queryFn: () => api.get<ApiSettings>('/api/settings'),
});

export const integrationsQuery = queryOptions({
  queryKey: ['integrations'],
  queryFn: () => api.get<ApiIntegrations>('/api/integrations'),
});

export const runnerCredentialsQuery = queryOptions({
  queryKey: ['runner-credentials'],
  queryFn: () => api.get<ApiRunnerCredentialsList>('/api/runner-credentials'),
});
