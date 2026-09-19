import { keepPreviousData, QueryClient, queryOptions } from '@tanstack/react-query';
import {
  getAgent,
  getAgents,
  getAutomation,
  getAutomationRun,
  getAutomationRuns,
  getAutomations,
  getBoard,
  getCurrentUser,
  getDeliveryChat,
  getFeature,
  getFeatureDiff,
  getFeatureExplanation,
  getIntegrations,
  getInvitation,
  getModels,
  getOrganizationMembers,
  getRepositoryCode,
  getRepositoryFile,
  getRepositoryTree,
  getSettings,
  getSkill,
  getSkillCatalog,
  getSkills,
  getTask,
  getUsage,
} from './backend.ts';
import { CHAT_TURN_PENDING } from './chat-rail.ts';
import type { ApiTaskSummary } from '../types.ts';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      // Keep visited pages warm for the whole session: re-entering a route
      // renders the cached page instantly (stale data refetches in the
      // background) instead of falling back to the pending skeleton.
      gcTime: 30 * 60_000,
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});

// Slow fallback cadence while an agent is working. Fast updates come from
// the version poll (use-live-refresh.ts), which invalidates these queries
// within seconds of an actual change — this interval only covers a missed
// bump, so it can be leisurely.
export const LIVE_POLL_MS = 30_000;

const RUNNING_PLAN_STATUSES = new Set(['analyzing', 'refining']);

// Feature states where generation stopped without a PR — terminal until the
// user retries.
export const GENERATION_STOPPED = new Set(['failed', 'checks_failed', 'no_changes']);

// A stopped feature whose retry is already on the queue: the retry routes
// stamp features.error with this before the workflow flips the status to
// 'generating', so the stopped state is momentary — keep polling it, and
// don't offer (or colour as an error) another retry.
export function retryQueued(error: string | null | undefined): boolean {
  return error === 'retry queued' || error?.startsWith('retry scheduled in ') === true;
}

export function taskIsLive(p: ApiTaskSummary): boolean {
  if (RUNNING_PLAN_STATUSES.has(p.status)) return true;
  if (p.repos.some((r) => r.verification?.status === 'running')) return true;
  // Approved and some repo has no PR yet: that repo's generation is in
  // flight unless it stopped.
  return (
    p.status === 'approved' &&
    p.repos.some(
      (r) =>
        !r.pr_number &&
        (!GENERATION_STOPPED.has(r.feature_status ?? '') || retryQueued(r.feature_error)),
    )
  );
}

export const meQuery = queryOptions({
  queryKey: ['me'],
  queryFn: getCurrentUser,
  staleTime: 60_000,
  refetchInterval: (query) => {
    const status = query.state.data?.githubStatus;
    if (status === 'syncing') return 2_000;
    if (status === 'reauthorization_required') return 5_000;
    if (status === 'temporarily_unavailable') return 15_000;
    // Detect a provider credential that disappeared after the last durable
    // membership snapshot without making navigation wait on GitHub.
    return 60_000;
  },
});

export const boardPageQuery = (page: { activeBefore?: number; historyBefore?: number } = {}) =>
  queryOptions({
    queryKey: page.activeBefore || page.historyBefore ? ['board', page] : ['board'],
    queryFn: () => getBoard(page),
    refetchInterval: (query) => (query.state.data?.tasks.some(taskIsLive) ? LIVE_POLL_MS : false),
  });
export const boardQuery = boardPageQuery();

export const taskQuery = (id: number) =>
  queryOptions({
    queryKey: ['task', id],
    queryFn: () => getTask(id),
    refetchInterval: (query) =>
      query.state.data && taskIsLive(query.state.data) ? LIVE_POLL_MS : false,
  });

export const usageQuery = queryOptions({
  queryKey: ['usage'],
  queryFn: getUsage,
});

// Terminal fix-run outcomes for a cockpit comment's linked batch — anything
// else (null while running) means the batch is still in flight.
export const FIX_TERMINAL = new Set(['fixed', 'no_changes', 'tests_failed', 'failed']);

export const featureQuery = (id: number) =>
  queryOptions({
    queryKey: ['feature', id],
    queryFn: () => getFeature(id),
    refetchInterval: (query) => {
      const d = query.state.data;
      if (!d) return false;
      // Poll while generation is in flight (no PR yet, not stopped) or a
      // verification run is live.
      if (!d.pr && (!GENERATION_STOPPED.has(d.feature.status) || retryQueued(d.feature.error))) {
        return LIVE_POLL_MS;
      }
      if (d.verification?.status === 'running') return LIVE_POLL_MS;
      // Poll while a comment batch's fix run hasn't resolved yet.
      const fixInFlight = d.comments.some(
        (c) => c.status === 'dispatched' && !FIX_TERMINAL.has(c.fix_status ?? ''),
      );
      if (fixInFlight) return LIVE_POLL_MS;
      return false;
    },
  });

export const featureDiffQuery = (id: number, version: string | null) =>
  queryOptions({
    queryKey: ['feature-diff', id, version],
    queryFn: () => getFeatureDiff(id),
    // A PR/CR diff is a snapshot. Mutations that push a new commit explicitly
    // invalidate this key; status/comment refreshes leave it untouched.
    staleTime: Infinity,
    gcTime: 30 * 60_000,
  });

// The Explain tab's document for the diff version on screen. Polls while a
// run is in flight; a finished row is immutable, like the diff snapshot.
export const featureExplainQuery = (id: number, version: string | null) =>
  queryOptions({
    queryKey: ['feature-explain', id, version],
    queryFn: () => getFeatureExplanation(id),
    refetchInterval: (query) => (query.state.data?.status === 'running' ? EXPLAIN_POLL_MS : false),
    staleTime: (query) => (query.state.data?.status === 'ready' ? Infinity : 0),
  });
export const EXPLAIN_POLL_MS = 4_000;

// While a user turn is in flight the rail polls until the reply lands.
export const chatQuery = (featureId: number) =>
  queryOptions({
    queryKey: ['chat', featureId],
    queryFn: () => getDeliveryChat(featureId),
    refetchInterval: (query) =>
      query.state.data?.messages.some((m) => m.role === 'user' && CHAT_TURN_PENDING.has(m.status))
        ? LIVE_POLL_MS
        : false,
  });

// Immutable agent logs are fetched lazily when expanded.
export const agentRunLogQuery = (id: number) =>
  queryOptions({
    queryKey: ['agent-run-log', id],
    queryFn: async () => {
      const response = await fetch(`/protocol/agent-runs/${id}/log`, {
        headers: { accept: 'text/plain' },
      });
      if (!response.ok) throw new Error(`agent log request failed (${response.status})`);
      return { log: await response.text() };
    },
    staleTime: Infinity,
  });

export const modelsQuery = queryOptions({
  queryKey: ['models'],
  queryFn: getModels,
  staleTime: 5 * 60_000, // operator SQL edits are rare; no need to poll
});

export const agentsQuery = queryOptions({
  queryKey: ['agents'],
  queryFn: getAgents,
});

export const agentQuery = (id: number) =>
  queryOptions({
    queryKey: ['agent', id],
    queryFn: () => getAgent(id),
  });

export const skillsQuery = queryOptions({
  queryKey: ['skills'],
  queryFn: getSkills,
});

// Server-side skills.sh proxy for the browse page. keepPreviousData keeps
// the current results on screen while a debounced search term refetches.
export const skillCatalogQuery = (q: string, sort: string) =>
  queryOptions({
    queryKey: ['skill-catalog', q, sort],
    queryFn: () => getSkillCatalog(q, sort),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });

export const skillQuery = (id: number) =>
  queryOptions({
    queryKey: ['skill', id],
    queryFn: () => getSkill(id),
  });

export const settingsQuery = queryOptions({
  queryKey: ['settings'],
  queryFn: getSettings,
});

export const orgMembersQuery = (organizationId: string) =>
  queryOptions({
    queryKey: ['org-members', organizationId],
    queryFn: () => getOrganizationMembers(organizationId),
  });

// Never retried: every failure here (not found, expired, wrong account) is a
// definitive answer the page turns into a message, not a transient.
export const invitationQuery = (id: string) =>
  queryOptions({
    queryKey: ['invitation', id],
    queryFn: () => getInvitation(id),
    retry: false,
    staleTime: 0,
  });

export const integrationsQuery = queryOptions({
  queryKey: ['integrations'],
  queryFn: getIntegrations,
});

export const automationsQuery = queryOptions({
  queryKey: ['automations'],
  queryFn: getAutomations,
});

export const automationQuery = (id: number) =>
  queryOptions({
    queryKey: ['automation', id],
    queryFn: () => getAutomation(id),
  });

export const automationRunsQuery = (id: number) =>
  queryOptions({
    queryKey: ['automation-runs', id],
    queryFn: () => getAutomationRuns(id),
    refetchInterval: (query) =>
      query.state.data?.runs.some((r) => r.status === 'running') ? LIVE_POLL_MS : false,
  });

// --- Repo code browser (the lazy /repos/$repoId/code/$ page) ---

export const repoCodeQuery = (repoId: number) =>
  queryOptions({
    queryKey: ['repo-code', repoId],
    queryFn: () => getRepositoryCode(repoId),
    staleTime: 60_000,
  });

export const repoTreeQuery = (repoId: number, ref: string, path: string) =>
  queryOptions({
    queryKey: ['repo-tree', repoId, ref, path],
    queryFn: () => getRepositoryTree(repoId, ref, path),
    staleTime: 60_000,
  });

export const repoFileQuery = (repoId: number, ref: string, path: string) =>
  queryOptions({
    queryKey: ['repo-file', repoId, ref, path],
    queryFn: () => getRepositoryFile(repoId, ref, path),
    staleTime: 60_000,
  });

export const automationRunQuery = (id: number) =>
  queryOptions({
    queryKey: ['automation-run', id],
    queryFn: () => getAutomationRun(id),
    refetchInterval: (query) => (query.state.data?.run.status === 'running' ? LIVE_POLL_MS : false),
  });
