import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import {
  BarChart2,
  Bot,
  Keyboard,
  LayoutDashboard,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Repeat,
  Search,
  Settings,
  Sparkles,
} from 'lucide-react';
import { lazy, Suspense, useState, type ReactNode } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import type { ApiMe } from '../../shared/api-types.ts';
import { codeRoute } from '../lib/layout.ts';
import { navShortcuts, noOverlayOpen } from '../lib/shortcuts.ts';
import { useIsDesktop } from '../lib/use-is-desktop.ts';
import { useLiveRefresh } from '../lib/use-live-refresh.ts';
import { cn } from '../lib/utils.ts';
import { Lamp } from './identity.tsx';
import { Kbd } from './ui/kbd.tsx';

const CommandPalette = lazy(() =>
  import('./command-palette.tsx').then((module) => ({ default: module.CommandPalette })),
);
const ShortcutHelp = lazy(() =>
  import('./shortcut-help.tsx').then((module) => ({ default: module.ShortcutHelp })),
);

// Control-room nav: every destination is a station with a distinct icon,
// lit where you are, dark elsewhere. Settings is the single admin
// destination (notifications, repos, org members live inside it). The
// mobile bottom bar has six slots, so Usage yields its slot there and rides
// as a link row inside Settings instead. `short` fits the bottom bar's
// slots without truncation.
export const SIDEBAR_NAV = [
  { to: '/', label: 'Board', exact: true, icon: LayoutDashboard },
  { to: '/agents', label: 'Agents', icon: Bot },
  { to: '/skills', label: 'Skills', icon: Sparkles },
  { to: '/automations', label: 'Automations', icon: Repeat },
  { to: '/integrations', label: 'Integrations', icon: Plug },
  { to: '/usage', label: 'Usage', icon: BarChart2 },
  { to: '/settings', label: 'Settings', icon: Settings },
] as const;

// Sidebar collapse preference (shadcn-style icon rail; see AppShell).
const SIDEBAR_KEY = 'turbodiff.sidebar';

const BOTTOM_NAV = [
  { to: '/', label: 'Board', short: 'Board', exact: true, icon: LayoutDashboard },
  { to: '/agents', label: 'Agents', short: 'Agents', icon: Bot },
  { to: '/skills', label: 'Skills', short: 'Skills', icon: Sparkles },
  { to: '/automations', label: 'Automations', short: 'Autos', icon: Repeat },
  { to: '/integrations', label: 'Integrations', short: 'MCP', icon: Plug },
  { to: '/settings', label: 'Settings', short: 'Settings', icon: Settings },
] as const;

function GithubRecoveryBanner({ me }: { me: ApiMe }) {
  if (me.github_status === 'ready') return null;

  let message: ReactNode;
  let action: ReactNode;
  switch (me.github_status) {
    case 'not_connected':
      message = <>GitHub isn&rsquo;t connected — the factory can&rsquo;t reach repositories yet.</>;
      action = (
        <a href="/onboarding" className="font-medium text-accent-bright hover:underline">
          Connect GitHub &rarr;
        </a>
      );
      break;
    case 'reauthorization_required':
      message = (
        <>Your GitHub authorization is missing or expired. Your Turbodiff account is safe.</>
      );
      action = (
        <a
          href="/auth/connect/github?next=/onboarding"
          className="font-medium text-accent-bright hover:underline"
        >
          Re-authorize GitHub &rarr;
        </a>
      );
      break;
    case 'temporarily_unavailable':
      message = <>GitHub access couldn&rsquo;t be verified. Native projects remain available.</>;
      action = (
        <a href="/onboarding" className="font-medium text-accent-bright hover:underline">
          Retry or re-authorize &rarr;
        </a>
      );
      break;
    case 'app_not_installed':
      message = <>GitHub is connected, but no GitHub App installation is available to you.</>;
      action = (
        <a
          href={`https://github.com/apps/${me.github_app_slug}/installations/new`}
          className="font-medium text-accent-bright hover:underline"
        >
          Install or configure the GitHub App &rarr;
        </a>
      );
      break;
    case 'syncing':
      message = <>Restoring your GitHub installations and repositories after sign-in.</>;
      action = (
        <a href="/onboarding" className="font-medium text-accent-bright hover:underline">
          View recovery status &rarr;
        </a>
      );
      break;
  }

  return (
    <div className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-line-2/70 bg-surface/60 px-4 py-3 text-[0.85rem] text-ink-dim">
      <Lamp tone={me.github_status === 'syncing' ? 'go' : 'hold'} />
      {message}
      {action}
    </div>
  );
}

function Logo() {
  return (
    <Link
      to="/"
      className="flex items-baseline gap-0.5 font-mono text-base font-semibold tracking-wide text-ink"
    >
      turbodiff
      <span className="animate-cursor text-accent-bright" aria-hidden>
        _
      </span>
    </Link>
  );
}

function isActive(pathname: string, to: string, exact?: boolean): boolean {
  return exact ? pathname === to : pathname.startsWith(to);
}

function SidebarNav({ collapsed }: { collapsed: boolean }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5">
      {SIDEBAR_NAV.map(({ to, label, icon: Icon, ...item }, i) => {
        const active = isActive(pathname, to, 'exact' in item && item.exact);
        return (
          <Link
            key={to}
            to={to}
            aria-current={active ? 'page' : undefined}
            // Collapsed rows lose their visible label, but keep the digit
            // shortcut hint in the tooltip (the hotkeys themselves are bound
            // in AppShell, so they work either way).
            title={collapsed ? `${label} (${i + 1})` : undefined}
            aria-label={collapsed ? label : undefined}
            className={cn(
              'flex items-center border-l-2 font-mono text-[11px] tracking-[0.14em] uppercase transition-colors',
              collapsed ? 'justify-center px-0 py-2' : 'gap-2.5 px-3 py-[7px]',
              active
                ? 'border-accent-bright bg-surface text-ink'
                : 'border-transparent text-mute hover:bg-surface/60 hover:text-ink-dim',
            )}
          >
            <Icon className="size-3.5" aria-hidden />
            <span className={cn(collapsed && 'hidden')}>{label}</span>
            <Kbd className={cn('ml-auto', collapsed && 'hidden')}>{i + 1}</Kbd>
          </Link>
        );
      })}
    </nav>
  );
}

// Mobile: a fixed bottom tab bar — every destination always visible and
// thumb-reachable, instead of a horizontally scrolling top row.
function BottomTabs() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-line/60 bg-bg/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
    >
      {/* flex, not a fixed column count, so adding a destination can never
          wrap the bar onto a second row */}
      <div className="flex">
        {BOTTOM_NAV.map(({ to, label, short, icon: Icon, ...item }) => {
          const active = isActive(pathname, to, 'exact' in item && item.exact);
          return (
            <Link
              key={to}
              to={to}
              aria-label={label}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex min-w-0 flex-1 flex-col items-center gap-1.5 py-2.5 font-mono text-[9px] tracking-[0.08em] uppercase transition-colors active:scale-95',
                active ? 'text-accent-bright' : 'text-mute',
              )}
            >
              <Icon className="size-3.5" aria-hidden />
              <span className="max-w-full truncate px-0.5">{short}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

function UserBlock({ me, collapsed = false }: { me: ApiMe; collapsed?: boolean }) {
  return (
    <div
      className={cn('flex items-center gap-2', collapsed ? 'justify-center' : 'justify-between')}
    >
      <span className={cn('truncate font-mono text-xs text-mute', collapsed && 'hidden')}>
        {me.login ? `@${me.login}` : me.name}
      </span>
      <form method="post" action="/auth/logout">
        <button
          className={cn(
            'flex cursor-pointer items-center gap-1.5 rounded-md text-xs text-mute hover:bg-raised hover:text-ink',
            collapsed ? 'p-1.5' : 'px-2 py-1',
          )}
          title="Sign out"
          aria-label="Sign out"
        >
          <LogOut className="size-3.5" aria-hidden />
          <span className={cn(collapsed && 'hidden')}>Sign out</span>
        </button>
      </form>
    </div>
  );
}

// Desktop: fixed sidebar. Small screens: sticky top bar with the same nav.
// The cockpit's diff pane needs room, so that route gets a much wider
// container than the reading-width default.
// Digit shortcuts derive from the sidebar order, so the two can't drift apart.
const NAV_SHORTCUTS = navShortcuts(SIDEBAR_NAV);

export function AppShell({ me, children }: { me: ApiMe; children: ReactNode }) {
  // Container width follows the *committed* route, not the optimistic
  // location — during a pending navigation the old page is still mounted,
  // and reflowing it to the destination's width reads as a broken shell.
  const pathname = useRouterState({
    select: (s) => (s.resolvedLocation ?? s.location).pathname,
  });
  const navigate = useNavigate();
  const isDesktop = useIsDesktop();
  // App-wide live updates: one tiny version poll instead of per-page
  // full-payload polling (see use-live-refresh.ts).
  useLiveRefresh(me.installation_ids);
  useHotkeys(
    NAV_SHORTCUTS.map((s) => s.key).join(','),
    (_e, hk) => {
      const hit = NAV_SHORTCUTS.find((s) => s.key === hk.keys?.join(''));
      if (hit) void navigate({ to: hit.to });
    },
    { enabled: () => isDesktop && noOverlayOpen(), preventDefault: true },
    [isDesktop],
  );
  const [helpOpen, setHelpOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // ⌘K toggles the palette; while some *other* overlay is open it stays
  // closed rather than stacking dialogs.
  useHotkeys(
    'mod+k',
    () => setPaletteOpen((prev) => (prev ? false : noOverlayOpen())),
    { preventDefault: true, enableOnFormTags: true },
    [],
  );
  // The code browser gets the whole viewport — a full-width, full-height
  // workspace on desktop — and forces the sidebar collapsed (below).
  // codeRoute lives in lib/layout.ts so the route-shape rule is shared and
  // independently tested.
  // pathname above is the *resolved* location, so the sidebar snaps
  // collapsed in the same frame the code page commits, matching the
  // container-width behavior.
  const code = codeRoute(pathname);
  // Sidebar collapse, shadcn-style (icon rail + ⌘B + persistence + a
  // data-state attribute on the aside), hand-rolled with the repo's tokens.
  // Saved preference — every route except the code browser.
  const [prefOpen, setPrefOpen] = useState(() => localStorage.getItem(SIDEBAR_KEY) !== 'closed');
  // Route-local override for the code browser: entering always starts
  // collapsed (the editor wants the room); toggling there is remembered only
  // while on the route and never touches the saved preference.
  const [codeOpen, setCodeOpen] = useState(false);
  // Reset the override on every non-code → code transition (React's
  // adjust-state-during-render pattern — no effect, so there's no
  // one-frame flash of the stale state).
  const [prevCode, setPrevCode] = useState(code);
  if (code !== prevCode) {
    setPrevCode(code);
    if (code) setCodeOpen(false);
  }
  const sidebarOpen = code ? codeOpen : prefOpen;
  const toggleSidebar = () => {
    if (code) {
      setCodeOpen((prev) => !prev);
    } else {
      setPrefOpen((prev) => {
        localStorage.setItem(SIDEBAR_KEY, prev ? 'closed' : 'open');
        return !prev;
      });
    }
  };
  useHotkeys(
    'mod+b',
    toggleSidebar,
    { enabled: () => isDesktop && noOverlayOpen(), preventDefault: true },
    [isDesktop, code],
  );
  // The cockpit's diff pane needs room, so that route gets a much wider
  // container than the reading-width default.
  const wide = pathname.startsWith('/factory/features/');
  // The board's three lanes need more room than the reading-width default.
  const board = pathname === '/';
  return (
    <div className="min-h-dvh md:flex">
      <aside
        data-state={sidebarOpen ? 'expanded' : 'collapsed'}
        className={cn(
          'sticky top-0 hidden h-dvh shrink-0 flex-col justify-between border-r border-line bg-surface/50 transition-[width] duration-200 md:flex',
          sidebarOpen ? 'w-52 p-4' : 'w-12 items-center p-2',
        )}
      >
        <div className="space-y-6">
          <div
            className={cn('flex items-center', sidebarOpen ? 'justify-between' : 'justify-center')}
          >
            {sidebarOpen ? <Logo /> : null}
            <button
              type="button"
              onClick={toggleSidebar}
              title={sidebarOpen ? 'Collapse sidebar (⌘B)' : 'Expand sidebar (⌘B)'}
              aria-label={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
              aria-expanded={sidebarOpen}
              className="cursor-pointer rounded-md p-1 text-mute transition-colors hover:bg-raised/60 hover:text-ink"
            >
              {sidebarOpen ? (
                <PanelLeftClose className="size-3.5" aria-hidden />
              ) : (
                <PanelLeftOpen className="size-3.5" aria-hidden />
              )}
            </button>
          </div>
          <div className="space-y-3">
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              title={sidebarOpen ? undefined : 'Jump to… (⌘K)'}
              aria-label={sidebarOpen ? undefined : 'Jump to…'}
              className={cn(
                'flex cursor-pointer items-center rounded-md font-mono text-[11px] text-mute transition-colors',
                sidebarOpen
                  ? 'w-full gap-2 border border-line-2/70 bg-bg/60 px-2.5 py-1.5 hover:border-line-2 hover:text-ink'
                  : 'p-1.5 hover:bg-raised/60 hover:text-ink',
              )}
            >
              <Search className="size-3" aria-hidden />
              <span className={cn(!sidebarOpen && 'hidden')}>Jump to&hellip;</span>
              <Kbd className={cn('ml-auto', !sidebarOpen && 'hidden')}>⌘K</Kbd>
            </button>
            <SidebarNav collapsed={!sidebarOpen} />
          </div>
        </div>
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => setHelpOpen(true)}
            title={sidebarOpen ? undefined : 'Shortcuts (?)'}
            aria-label={sidebarOpen ? undefined : 'Shortcuts'}
            className={cn(
              'flex cursor-pointer items-center rounded-md font-mono text-[11px] text-mute transition-colors hover:bg-raised/60 hover:text-ink',
              sidebarOpen ? 'w-full gap-2 px-2 py-1' : 'p-1.5',
            )}
          >
            <Keyboard className="size-3.5" aria-hidden />
            <span className={cn(!sidebarOpen && 'hidden')}>Shortcuts</span>
            <Kbd className={cn('ml-auto', !sidebarOpen && 'hidden')}>?</Kbd>
          </button>
          <UserBlock me={me} collapsed={!sidebarOpen} />
        </div>
      </aside>

      <div className="sticky top-0 z-40 flex items-center justify-between border-b border-line/60 bg-bg/95 px-4 py-2.5 backdrop-blur md:hidden">
        <Logo />
        <UserBlock me={me} />
      </div>

      <main className="min-w-0 flex-1">
        {/* Width snaps in the same frame the new page commits (pathname above
            is the resolved location) — animating it would visibly reflow the
            outgoing page. */}
        <div
          className={cn(
            'mx-auto px-4 py-5 pb-28 sm:py-8 md:px-8 md:pb-8',
            code
              ? // Code browser: no width cap; at lg the container pins to the
                // viewport height and stops scrolling — the page's tree/editor
                // panes scroll internally instead.
                'max-w-none lg:flex lg:h-dvh lg:min-h-0 lg:flex-col lg:overflow-hidden lg:px-6 lg:pt-4 lg:pb-4'
              : wide
                ? 'max-w-[96rem]'
                : board
                  ? 'max-w-7xl'
                  : 'max-w-4xl',
          )}
        >
          <GithubRecoveryBanner me={me} />
          {children}
        </div>
      </main>

      <BottomTabs />
      {helpOpen ? (
        <Suspense fallback={null}>
          <ShortcutHelp
            nav={SIDEBAR_NAV}
            open={helpOpen}
            onOpenChange={setHelpOpen}
            onToggle={() => setHelpOpen((prev) => !prev)}
          />
        </Suspense>
      ) : null}
      {paletteOpen ? (
        <Suspense fallback={null}>
          <CommandPalette nav={SIDEBAR_NAV} open={paletteOpen} onOpenChange={setPaletteOpen} />
        </Suspense>
      ) : null}
    </div>
  );
}
