import { QueryClientProvider, useSuspenseQuery } from '@tanstack/react-query';
import {
	createRootRoute,
	createRoute,
	createRouter,
	lazyRouteComponent,
	Outlet,
	RouterProvider,
} from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from 'sonner';
import { AppShell } from './components/app-shell.tsx';
import { Button } from './components/ui/button.tsx';
import {
	agentQuery,
	agentsQuery,
	boardQuery,
	featureQuery,
	integrationsQuery,
	meQuery,
	queryClient,
	settingsQuery,
	taskQuery,
	usageQuery,
} from './lib/queries.ts';
import { AgentEditPage } from './pages/agent-edit.tsx';
import { AgentNewPage } from './pages/agent-new.tsx';
import { AgentsPage } from './pages/agents.tsx';
import { BoardPage } from './pages/board.tsx';
import { IntegrationsPage } from './pages/integrations.tsx';
import { SettingsPage } from './pages/settings.tsx';
import { TaskPage } from './pages/task.tsx';
import { UsagePage } from './pages/usage.tsx';
import './styles.css';

function RootLayout() {
	const { data: me } = useSuspenseQuery(meQuery);
	return (
		<AppShell login={me.login}>
			<Outlet />
		</AppShell>
	);
}

function Pending() {
	return (
		<div className="flex min-h-64 items-center justify-center text-mute" role="status">
			<span>
				loading<span className="animate-cursor text-accent-bright">_</span>
			</span>
		</div>
	);
}

function RouteError({ error, reset }: { error: Error; reset: () => void }) {
	return (
		<div className="mx-auto mt-16 max-w-md text-center">
			<p className="section-mark text-ink-dim">something broke</p>
			<p className="mt-2 text-[0.85rem] text-mute">{error.message}</p>
			<div className="mt-4">
				<Button variant="secondary" onClick={reset}>
					Try again
				</Button>
			</div>
		</div>
	);
}

function NotFound() {
	return (
		<div className="mx-auto mt-16 max-w-md text-center">
			<p className="section-mark text-ink-dim">404 — no such page</p>
			<p className="mt-2 text-[0.85rem] text-mute">
				<a href="/" className="text-accent-bright hover:underline">
					back to the dashboard &rarr;
				</a>
			</p>
		</div>
	);
}

const rootRoute = createRootRoute({
	component: RootLayout,
	loader: () => queryClient.ensureQueryData(meQuery),
	notFoundComponent: NotFound,
});

const boardRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/',
	loader: () => queryClient.ensureQueryData(boardQuery),
	component: BoardPage,
});

const taskRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/tasks/$taskId',
	loader: ({ params }) => queryClient.ensureQueryData(taskQuery(Number(params.taskId))),
	component: TaskPage,
});

const usageRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/usage',
	loader: () => queryClient.ensureQueryData(usageQuery),
	component: UsagePage,
});

const integrationsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/integrations',
	loader: () => queryClient.ensureQueryData(integrationsQuery),
	component: IntegrationsPage,
});

// The cockpit pulls in @pierre/diffs (+ syntax themes) — lazy so the rest of
// the app doesn't pay for it.
const featureRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/factory/features/$featureId',
	loader: ({ params }) => queryClient.ensureQueryData(featureQuery(Number(params.featureId))),
	component: lazyRouteComponent(() => import('./pages/feature.tsx')),
});

const agentsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/agents',
	loader: () => queryClient.ensureQueryData(agentsQuery),
	component: AgentsPage,
});

const agentNewRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/agents/new',
	validateSearch: (search: Record<string, unknown>) => ({
		installation: Number(search.installation) || 0,
	}),
	loader: () => queryClient.ensureQueryData(agentsQuery),
	component: AgentNewPage,
});

const agentEditRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/agents/$agentId/edit',
	loader: ({ params }) => queryClient.ensureQueryData(agentQuery(Number(params.agentId))),
	component: AgentEditPage,
});

const settingsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/settings',
	loader: () => queryClient.ensureQueryData(settingsQuery),
	component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
	boardRoute,
	taskRoute,
	usageRoute,
	integrationsRoute,
	featureRoute,
	agentsRoute,
	agentNewRoute,
	agentEditRoute,
	settingsRoute,
]);

const router = createRouter({
	routeTree,
	defaultPreload: 'intent',
	defaultPendingComponent: Pending,
	defaultErrorComponent: RouteError,
	// react-query owns caching; let loaders re-run on navigation.
	defaultPreloadStaleTime: 0,
});

declare module '@tanstack/react-router' {
	interface Register {
		router: typeof router;
	}
}

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<RouterProvider router={router} />
			<Toaster
				position="bottom-right"
				theme="dark"
				toastOptions={{
					style: {
						background: 'var(--color-surface)',
						border: '1px solid var(--color-line-2)',
						color: 'var(--color-ink)',
						fontFamily: 'var(--font-mono)',
						fontSize: '0.8rem',
					},
				}}
			/>
		</QueryClientProvider>
	</StrictMode>,
);
