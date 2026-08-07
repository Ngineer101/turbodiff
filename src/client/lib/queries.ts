import { QueryClient, queryOptions } from '@tanstack/react-query';
import { api } from './api.ts';
import type {
	ApiAgentDetail,
	ApiAgentsList,
	ApiDashboard,
	ApiFactory,
	ApiFeatureDetail,
	ApiMe,
	ApiReviewsPage,
	ApiSettings,
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

// Poll cadence while an agent is working — replaces v1's full-page
// `location.reload()` every 10s.
export const LIVE_POLL_MS = 5_000;

export const meQuery = queryOptions({
	queryKey: ['me'],
	queryFn: () => api.get<ApiMe>('/api/me'),
	staleTime: Infinity,
});

export const dashboardQuery = queryOptions({
	queryKey: ['dashboard'],
	queryFn: () => api.get<ApiDashboard>('/api/dashboard'),
	refetchInterval: (query) =>
		query.state.data?.recent_reviews.some((r) => r.state === 'running') ? LIVE_POLL_MS : false,
});

export const reviewsQuery = (page: number) =>
	queryOptions({
		queryKey: ['reviews', page],
		queryFn: () => api.get<ApiReviewsPage>(`/api/reviews?page=${page}`),
		refetchInterval: (query) =>
			query.state.data?.reviews.some((r) => r.state === 'running') ? LIVE_POLL_MS : false,
	});

const RUNNING_PLAN_STATUSES = new Set(['analyzing', 'refining']);

export const factoryQuery = queryOptions({
	queryKey: ['factory'],
	queryFn: () => api.get<ApiFactory>('/api/factory'),
	refetchInterval: (query) =>
		query.state.data?.plans.some(
			(p) => RUNNING_PLAN_STATUSES.has(p.status) || p.verification?.status === 'running',
		)
			? LIVE_POLL_MS
			: false,
});

export const featureQuery = (id: number) =>
	queryOptions({
		queryKey: ['feature', id],
		queryFn: () => api.get<ApiFeatureDetail>(`/api/factory/features/${id}`),
		refetchInterval: (query) => {
			const d = query.state.data;
			if (!d) return false;
			// Poll while generation hasn't opened a PR or verification is running.
			return !d.pr || d.verification?.status === 'running' ? LIVE_POLL_MS : false;
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
