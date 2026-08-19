// The '*.css' module declaration must travel with this file: the pre-commit
// checker builds a program from the staged files alone, which drops
// tsconfig-included d.ts files like vite-env.d.ts.
import './vite-env.d.ts';
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
  settingsQuery,
  skillQuery,
  skillsQuery,
  taskQuery,
  usageQuery,
} from './lib/queries.ts';
import { AgentEditPage } from './pages/agent-edit.tsx';
import { AgentNewPage } from './pages/agent-new.tsx';
import { AgentsPage } from './pages/agents.tsx';
import { AutomationEditPage } from './pages/automation-edit.tsx';
import { AutomationNewPage } from './pages/automation-new.tsx';
import { AutomationRunPage } from './pages/automation-run.tsx';
import { AutomationsPage } from './pages/automations.tsx';
import { BoardPage } from './pages/board.tsx';
import { ConfigPage } from './pages/config.tsx';
import { IntegrationsPage } from './pages/integrations.tsx';
import { MembersPage } from './pages/members.tsx';
import { OnboardingPage } from './pages/onboarding.tsx';
import { SettingsPage } from './pages/settings.tsx';
import { SkillEditPage } from './pages/skill-edit.tsx';
import { SkillNewPage } from './pages/skill-new.tsx';
import { SkillsPage } from './pages/skills.tsx';
import { TaskPage } from './pages/task.tsx';
import { UsagePage } from './pages/usage.tsx';
import './styles.css';

function ShellLayout() {
  const { data: me } = useSuspenseQuery(meQuery);
  return (
    <AppShell me={me}>
      <Outlet />
    </AppShell>
  );
}

function Pending() {
  return (
    <div className="flex min-h-64 items-center justify-center text-mute" role="status">
      <span>
        Loading<span className="animate-cursor text-accent-bright">_</span>
      </span>
    </div>
  );
}

function Splash() {
  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center gap-4 bg-bg" role="status">
      <img src="/logo-small.png" alt="Turbodiff" width="56" height="56" />
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
  component: OnboardingPage,
});

const boardRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/',
  loader: () => queryClient.ensureQueryData(boardQuery),
  component: BoardPage,
});

const taskRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/tasks/$taskId',
  loader: ({ params }) => queryClient.ensureQueryData(taskQuery(Number(params.taskId))),
  component: TaskPage,
});

const usageRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/usage',
  loader: () => queryClient.ensureQueryData(usageQuery),
  component: UsagePage,
});

const integrationsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/integrations',
  loader: () => queryClient.ensureQueryData(integrationsQuery),
  component: IntegrationsPage,
});

// The cockpit pulls in @pierre/diffs (+ syntax themes) — lazy so the rest of
// the app doesn't pay for it.
const featureRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/factory/features/$featureId',
  loader: ({ params }) => queryClient.ensureQueryData(featureQuery(Number(params.featureId))),
  component: lazyRouteComponent(() => import('./pages/feature.tsx')),
});

const agentsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/agents',
  loader: () => queryClient.ensureQueryData(agentsQuery),
  component: AgentsPage,
});

const agentNewRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/agents/new',
  component: AgentNewPage,
});

const agentEditRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/agents/$agentId/edit',
  loader: ({ params }) => queryClient.ensureQueryData(agentQuery(Number(params.agentId))),
  component: AgentEditPage,
});

const skillsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/skills',
  loader: () => queryClient.ensureQueryData(skillsQuery),
  component: SkillsPage,
});

const skillNewRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/skills/new',
  component: SkillNewPage,
});

const skillEditRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/skills/$skillId/edit',
  loader: ({ params }) => queryClient.ensureQueryData(skillQuery(Number(params.skillId))),
  component: SkillEditPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/settings',
  loader: () => queryClient.ensureQueryData(settingsQuery),
  component: SettingsPage,
});

const configRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/config',
  loader: () => queryClient.ensureQueryData(settingsQuery),
  component: ConfigPage,
});

const membersRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/settings/members/$installationId',
  loader: ({ params }) =>
    queryClient.ensureQueryData(orgMembersQuery(Number(params.installationId))),
  component: MembersPage,
});

const automationsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/automations',
  loader: () => queryClient.ensureQueryData(automationsQuery),
  component: AutomationsPage,
});

const automationNewRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/automations/new',
  loader: () => queryClient.ensureQueryData(automationsQuery),
  component: AutomationNewPage,
});

const automationEditRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/automations/$automationId/edit',
  loader: ({ params }) => queryClient.ensureQueryData(automationQuery(Number(params.automationId))),
  component: AutomationEditPage,
});

const automationRunRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/automations/runs/$runId',
  loader: ({ params }) => queryClient.ensureQueryData(automationRunQuery(Number(params.runId))),
  component: AutomationRunPage,
});

const routeTree = rootRoute.addChildren([
  onboardingRoute,
  shellRoute.addChildren([
    boardRoute,
    taskRoute,
    usageRoute,
    integrationsRoute,
    featureRoute,
    agentsRoute,
    agentNewRoute,
    agentEditRoute,
    skillsRoute,
    skillNewRoute,
    skillEditRoute,
    settingsRoute,
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
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

void registerServiceWorker();

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
