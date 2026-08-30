// The '*.css' module declaration must travel with this file: the pre-commit
// checker builds a program from the staged files alone, which drops
// tsconfig-included d.ts files like vite-env.d.ts.
import './vite-env.d.ts';
import { QueryClientProvider, useSuspenseQuery } from '@tanstack/react-query';
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';
import {
  persistQueryClientRestore,
  persistQueryClientSubscribe,
  type PersistQueryClientOptions,
} from '@tanstack/react-query-persist-client';
import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
  RouterProvider,
} from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from 'sonner';
import { isString, type JsonObject } from '../shared/json.ts';
import { AppShell } from './components/app-shell.tsx';
import { Button } from './components/ui/button.tsx';
import { registerServiceWorker } from './lib/push.ts';
import {
  agentQuery,
  agentsQuery,
  automationQuery,
  automationRunQuery,
  automationsQuery,
  boardQuery,
  featureQuery,
  integrationsQuery,
  meQuery,
  orgMembersQuery,
  queryClient,
  repoCodeQuery,
  settingsQuery,
  skillQuery,
  skillsQuery,
  taskQuery,
  usageQuery,
} from './lib/queries.ts';
import './styles.css';

function ShellLayout() {
  const { data: me } = useSuspenseQuery(meQuery);
  return (
    <AppShell me={me}>
      <Outlet />
    </AppShell>
  );
}

// Route-pending skeleton: page-shaped placeholders instead of a collapsed
// centered spinner, so the container keeps its height and nothing jumps
// when the real page lands.
function Pending() {
  return (
    <div className="animate-pulse space-y-6" role="status" aria-label="Loading page">
      <div className="h-7 w-64 max-w-full rounded-md bg-surface" />
      <div className="space-y-3">
        <div className="h-24 rounded-xl border border-line/60 bg-surface/70" />
        <div className="h-24 rounded-xl border border-line/60 bg-surface/70" />
        <div className="h-24 rounded-xl border border-line/60 bg-surface/50" />
      </div>
    </div>
  );
}

function Splash() {
  return (
    <div
      className="fixed inset-0 flex flex-col items-center justify-center gap-4 bg-bg"
      role="status"
    >
      <img src="/logo-small.png" alt="Turbodiff" width="56" height="56" className="rounded-lg" />
      <span className="text-mute">
        Loading<span className="animate-cursor text-accent-bright">_</span>
      </span>
    </div>
  );
}

function RouteError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mx-auto mt-16 max-w-md text-center">
      <p className="text-ink-dim">Something broke.</p>
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
      <p className="text-ink-dim">404 — no such page</p>
      <p className="mt-2 text-[0.85rem] text-mute">
        <a href="/" className="text-accent-bright hover:underline">
          Back to the dashboard &rarr;
        </a>
      </p>
    </div>
  );
}

const rootRoute = createRootRoute({
  loader: () => queryClient.ensureQueryData(meQuery),
  pendingComponent: Splash,
  pendingMs: 0,
  notFoundComponent: NotFound,
});

// Pathless layout: every signed-in page lives inside the AppShell chrome.
// /onboarding sits outside it — a focused page with no nav to wander off to.
const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'shell',
  component: ShellLayout,
});

const onboardingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/onboarding',
  component: lazyRouteComponent(() => import('./pages/onboarding.tsx'), 'OnboardingPage'),
});

const boardRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/',
  loader: () => queryClient.ensureQueryData(boardQuery),
  component: lazyRouteComponent(() => import('./pages/board.tsx'), 'BoardPage'),
});

const taskRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/tasks/$taskId',
  loader: ({ params }) => queryClient.ensureQueryData(taskQuery(Number(params.taskId))),
  component: lazyRouteComponent(() => import('./pages/task.tsx'), 'TaskPage'),
});

const usageRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/usage',
  loader: () => queryClient.ensureQueryData(usageQuery),
  component: lazyRouteComponent(() => import('./pages/usage.tsx'), 'UsagePage'),
});

const integrationsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/integrations',
  loader: () => queryClient.ensureQueryData(integrationsQuery),
  component: lazyRouteComponent(() => import('./pages/integrations.tsx'), 'IntegrationsPage'),
});

// The cockpit pulls in @pierre/diffs (+ syntax themes) — lazy so the rest of
// the app doesn't pay for it.
const featureRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/factory/features/$featureId',
  loader: ({ params }) => queryClient.ensureQueryData(featureQuery(Number(params.featureId))),
  component: lazyRouteComponent(() => import('./pages/feature.tsx')),
});

// The code browser: splat = file path, ?ref= = branch (a path segment would
// be ambiguous for branch names containing '/'). CodeMirror rides only in
// this chunk — same treatment as the cockpit.
const repoCodeRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/repos/$repoId/code/$',
  validateSearch: (s: JsonObject): { ref?: string } =>
    isString(s.ref) && s.ref ? { ref: s.ref } : {},
  loader: ({ params }) => queryClient.ensureQueryData(repoCodeQuery(Number(params.repoId))),
  component: lazyRouteComponent(() => import('./pages/code.tsx')),
});

const agentsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/agents',
  loader: () => queryClient.ensureQueryData(agentsQuery),
  component: lazyRouteComponent(() => import('./pages/agents.tsx'), 'AgentsPage'),
});

const agentNewRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/agents/new',
  component: lazyRouteComponent(() => import('./pages/agent-new.tsx'), 'AgentNewPage'),
});

// Turbodiff-hosted (Cloudflare Artifacts) project creation —
// docs/artifacts-provider.md.
const projectNewRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/projects/new',
  component: lazyRouteComponent(() => import('./pages/project-new.tsx'), 'ProjectNewPage'),
});

const agentEditRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/agents/$agentId/edit',
  loader: ({ params }) => queryClient.ensureQueryData(agentQuery(Number(params.agentId))),
  component: lazyRouteComponent(() => import('./pages/agent-edit.tsx'), 'AgentEditPage'),
});

const skillsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/skills',
  loader: () => queryClient.ensureQueryData(skillsQuery),
  component: lazyRouteComponent(() => import('./pages/skills.tsx'), 'SkillsPage'),
});

const skillNewRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/skills/new',
  component: lazyRouteComponent(() => import('./pages/skill-new.tsx'), 'SkillNewPage'),
});

const skillEditRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/skills/$skillId/edit',
  loader: ({ params }) => queryClient.ensureQueryData(skillQuery(Number(params.skillId))),
  component: lazyRouteComponent(() => import('./pages/skill-edit.tsx'), 'SkillEditPage'),
});

const settingsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/settings',
  loader: () => queryClient.ensureQueryData(settingsQuery),
  component: lazyRouteComponent(() => import('./pages/settings.tsx'), 'SettingsPage'),
});

// /config was a hub page (usage/settings/members links) before those moved
// into Settings proper — the redirect keeps old bookmarks working.
const configRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/config',
  beforeLoad: () => {
    throw redirect({ to: '/settings' });
  },
});

const membersRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/settings/members/$installationId',
  loader: ({ params }) =>
    queryClient.ensureQueryData(orgMembersQuery(Number(params.installationId))),
  component: lazyRouteComponent(() => import('./pages/members.tsx'), 'MembersPage'),
});

const automationsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/automations',
  loader: () => queryClient.ensureQueryData(automationsQuery),
  component: lazyRouteComponent(() => import('./pages/automations.tsx'), 'AutomationsPage'),
});

const automationNewRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/automations/new',
  loader: () => queryClient.ensureQueryData(automationsQuery),
  component: lazyRouteComponent(() => import('./pages/automation-new.tsx'), 'AutomationNewPage'),
});

const automationEditRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/automations/$automationId/edit',
  loader: ({ params }) => queryClient.ensureQueryData(automationQuery(Number(params.automationId))),
  component: lazyRouteComponent(() => import('./pages/automation-edit.tsx'), 'AutomationEditPage'),
});

const automationRunRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/automations/runs/$runId',
  loader: ({ params }) => queryClient.ensureQueryData(automationRunQuery(Number(params.runId))),
  component: lazyRouteComponent(() => import('./pages/automation-run.tsx'), 'AutomationRunPage'),
});

const routeTree = rootRoute.addChildren([
  onboardingRoute,
  shellRoute.addChildren([
    boardRoute,
    taskRoute,
    usageRoute,
    integrationsRoute,
    featureRoute,
    repoCodeRoute,
    agentsRoute,
    agentNewRoute,
    agentEditRoute,
    skillsRoute,
    skillNewRoute,
    skillEditRoute,
    settingsRoute,
    projectNewRoute,
    configRoute,
    membersRoute,
    automationsRoute,
    automationNewRoute,
    automationEditRoute,
    automationRunRoute,
  ]),
]);

const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  defaultPendingComponent: Pending,
  defaultErrorComponent: RouteError,
  // react-query owns caching; let loaders re-run on navigation.
  defaultPreloadStaleTime: 0,
  // Without these the router holds the *previous* page on screen for up to
  // 1s (its defaultPendingMs) on cold loads — cached navigations stay
  // instant, cold ones show the skeleton almost immediately instead of a
  // frozen stale page.
  defaultPendingMs: 100,
  defaultPendingMinMs: 200,
  scrollRestoration: true,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

void registerServiceWorker();
// Monitoring is a post-boot concern: keep it out of the interaction-critical
// graph and initialize it only when the browser has idle time.
const startMonitoring = () =>
  void import('./lib/performance.ts').then(({ startPerformanceMonitoring }) =>
    startPerformanceMonitoring(),
  );
if ('requestIdleCallback' in window) {
  window.requestIdleCallback(startMonitoring, { timeout: 5_000 });
} else {
  setTimeout(startMonitoring, 2_000);
}

// Warm-boot persistence: the last-known payloads of the cheap, list-shaped
// queries hydrate from localStorage before first render, so a reload paints
// real content immediately and revalidates in the background. Heavy or
// fast-moving payloads (diffs, file contents, chat) stay memory-only.
const PERSISTED_KEYS = new Set([
  'board',
  'agents',
  'skills',
  'settings',
  'integrations',
  'automations',
  'usage',
]);
// Bump to drop persisted caches whose shape no longer matches the client.
const PERSIST_BUSTER = 'v3';
const persistOptions: PersistQueryClientOptions = {
  queryClient,
  persister: createSyncStoragePersister({
    storage: window.localStorage,
    key: 'turbodiff.queryCache',
  }),
  buster: PERSIST_BUSTER,
  maxAge: 24 * 60 * 60 * 1000,
  dehydrateOptions: {
    shouldDehydrateQuery: (query) =>
      query.state.status === 'success' && PERSISTED_KEYS.has(String(query.queryKey[0])),
  },
};
// Restore BEFORE the router mounts: route loaders (ensureQueryData) run
// outside React, so an async restore would race them and a cold reload
// would still wait on the network. localStorage is synchronous — this
// resolves in the same tick.
await persistQueryClientRestore(persistOptions);
persistQueryClientSubscribe(persistOptions);

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
            fontFamily: 'var(--font-sans)',
            fontSize: '0.8rem',
          },
        }}
      />
    </QueryClientProvider>
  </StrictMode>,
);
