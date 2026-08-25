import { QueryClient, queryOptions } from '@tanstack/react-query';
import { api } from './api.ts';
import type {
  ApiAgentDetail,
  ApiAgentsList,
  ApiAutomationDetail,
  ApiAutomationRunDetail,
  ApiAutomationRunsList,
  ApiAutomationsList,
  ApiBoard,
  ApiChatList,
  ApiFeatureDetail,
  ApiIntegrations,
  ApiMe,
  ApiOrgMembers,
  ApiPlan,
  ApiRepoCode,
  ApiRepoFile,
  ApiRepoTree,
  ApiSettings,
  ApiSkillDetail,
  ApiSkillsList,
  ApiTaskDetail,
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
    queryFn: () => api.get<ApiTaskDetail>(`/api/tasks/${id}`),
    refetchInterval: (query) =>
      query.state.data && taskIsLive(query.state.data) ? LIVE_POLL_MS : false,
  });

export const usageQuery = queryOptions({
  queryKey: ['usage'],
  queryFn: () => api.get<ApiUsage>('/api/usage'),
});

// Terminal fix-run outcomes for a cockpit comment's linked batch — anything
// else (null while running) means the batch is still in flight.
export const FIX_TERMINAL = new Set(['fixed', 'no_changes', 'tests_failed', 'failed']);

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
      if (d.verification?.status === 'running') return LIVE_POLL_MS;
      // Poll while a comment batch's fix run hasn't resolved yet.
      const fixInFlight = d.comments.some(
        (c) => c.status === 'dispatched' && !FIX_TERMINAL.has(c.fix_status ?? ''),
      );
      if (fixInFlight) return LIVE_POLL_MS;
      return false;
    },
  });

// A user chat message in one of these states has a turn in flight — the
// panel polls and the input stays disabled until the reply lands.
export const CHAT_TURN_PENDING = new Set(['queued', 'running']);

export const chatQuery = (featureId: number) =>
  queryOptions({
    queryKey: ['chat', featureId],
    queryFn: () => api.get<ApiChatList>(`/api/factory/features/${featureId}/chat`),
    refetchInterval: (query) =>
      query.state.data?.messages.some(
        (m) => m.role === 'user' && CHAT_TURN_PENDING.has(m.status),
      )
        ? LIVE_POLL_MS
        : false,
  });

// Full transcript for one agent-session run — fetched lazily (enabled: open)
// by AgentRunLog, not on page load. Immutable once written, so no refetch.
export const agentRunLogQuery = (id: number) =>
  queryOptions({
    queryKey: ['agent-run-log', id],
    queryFn: () => api.get<{ log: string }>(`/api/factory/runs/${id}/log`),
    staleTime: Infinity,
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

export const skillsQuery = queryOptions({
  queryKey: ['skills'],
  queryFn: () => api.get<ApiSkillsList>('/api/skills'),
});

export const skillQuery = (id: number) =>
  queryOptions({
    queryKey: ['skill', id],
    queryFn: () => api.get<ApiSkillDetail>(`/api/skills/${id}`),
  });

export const settingsQuery = queryOptions({
  queryKey: ['settings'],
  queryFn: () => api.get<ApiSettings>('/api/settings'),
});

export const orgMembersQuery = (installationId: number) =>
  queryOptions({
    queryKey: ['org-members', installationId],
    queryFn: () => api.get<ApiOrgMembers>(`/api/organizations/${installationId}/members`),
  });

export const integrationsQuery = queryOptions({
  queryKey: ['integrations'],
  queryFn: () => api.get<ApiIntegrations>('/api/integrations'),
});

export const automationsQuery = queryOptions({
  queryKey: ['automations'],
  queryFn: () => api.get<ApiAutomationsList>('/api/automations'),
});

export const automationQuery = (id: number) =>
  queryOptions({
    queryKey: ['automation', id],
    queryFn: () => api.get<ApiAutomationDetail>(`/api/automations/${id}`),
  });

export const automationRunsQuery = (id: number) =>
  queryOptions({
    queryKey: ['automation-runs', id],
    queryFn: () => api.get<ApiAutomationRunsList>(`/api/automations/${id}/runs`),
    refetchInterval: (query) =>
      query.state.data?.runs.some((r) => r.status === 'running') ? LIVE_POLL_MS : false,
  });

// --- Repo code browser (the lazy /repos/$repoId/code/$ page) ---

export const repoCodeQuery = (repoId: number) =>
  queryOptions({
    queryKey: ['repo-code', repoId],
    queryFn: () => api.get<ApiRepoCode>(`/api/repos/${repoId}/code`),
    staleTime: 60_000,
  });

export const repoTreeQuery = (repoId: number, ref: string, path: string) =>
  queryOptions({
    queryKey: ['repo-tree', repoId, ref, path],
    queryFn: () =>
      api.get<ApiRepoTree>(
        `/api/repos/${repoId}/tree?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}`,
      ),
    staleTime: 60_000,
  });

export const repoFileQuery = (repoId: number, ref: string, path: string) =>
  queryOptions({
    queryKey: ['repo-file', repoId, ref, path],
    queryFn: () =>
      api.get<ApiRepoFile>(
        `/api/repos/${repoId}/file?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}`,
      ),
    staleTime: 60_000,
  });

export const automationRunQuery = (id: number) =>
  queryOptions({
    queryKey: ['automation-run', id],
    queryFn: () => api.get<ApiAutomationRunDetail>(`/api/automations/runs/${id}`),
    refetchInterval: (query) => (query.state.data?.run.status === 'running' ? LIVE_POLL_MS : false),
  });
