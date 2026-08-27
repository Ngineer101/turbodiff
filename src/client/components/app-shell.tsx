import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import {
  BarChart2,
  Bot,
  Keyboard,
  LayoutDashboard,
  LogOut,
  Plug,
  Repeat,
  Search,
  Settings,
  Sparkles,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import type { ApiMe } from '../../shared/api-types.ts';
import { codeRoute } from '../lib/layout.ts';
import { navShortcuts, noOverlayOpen } from '../lib/shortcuts.ts';
import { useIsDesktop } from '../lib/use-is-desktop.ts';
import { useLiveRefresh } from '../lib/use-live-refresh.ts';
import { cn } from '../lib/utils.ts';
import { CommandPalette } from './command-palette.tsx';
import { Lamp } from './identity.tsx';
import { ShortcutHelp } from './shortcut-help.tsx';
import { Kbd } from './ui/kbd.tsx';

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

const BOTTOM_NAV = [
  { to: '/', label: 'Board', short: 'Board', exact: true, icon: LayoutDashboard },
  { to: '/agents', label: 'Agents', short: 'Agents', icon: Bot },
  { to: '/skills', label: 'Skills', short: 'Skills', icon: Sparkles },
  { to: '/automations', label: 'Automations', short: 'Autos', icon: Repeat },
  { to: '/integrations', label: 'Integrations', short: 'MCP', icon: Plug },
  { to: '/settings', label: 'Settings', short: 'Settings', icon: Settings },
] as const;

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

function SidebarNav() {
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
            className={cn(
              'flex items-center gap-2.5 border-l-2 px-3 py-[7px] font-mono text-[11px] tracking-[0.14em] uppercase transition-colors',
              active
                ? 'border-accent-bright bg-surface text-ink'
                : 'border-transparent text-mute hover:bg-surface/60 hover:text-ink-dim',
            )}
          >
            <Icon className="size-3.5" aria-hidden />
            {label}
            <Kbd className="ml-auto">{i + 1}</Kbd>
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

function UserBlock({ me }: { me: ApiMe }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="truncate font-mono text-xs text-mute">
        {me.login ? `@${me.login}` : me.name}
      </span>
      <form method="post" action="/auth/logout">
        <button
          className="flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs text-mute hover:bg-raised hover:text-ink"
          title="Sign out"
        >
          <LogOut className="size-3.5" aria-hidden />
          Sign out
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
  useLiveRefresh();
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
  // The cockpit's diff pane needs room; the code browser gets the whole
  // viewport — a full-width, full-height workspace on desktop. codeRoute
  // lives in lib/layout.ts: Artifacts repos have negative ids, which a
  // bare \d+ here silently dropped into the reading-width container.
  const wide = pathname.startsWith('/factory/features/');
  const code = codeRoute(pathname);
  // The board's three lanes need more room than the reading-width default.
  const board = pathname === '/';
  return (
    <div className="min-h-dvh md:flex">
      <aside className="sticky top-0 hidden h-dvh w-52 shrink-0 flex-col justify-between border-r border-line bg-surface/50 p-4 md:flex">
        <div className="space-y-6">
          <Logo />
          <div className="space-y-3">
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              className="flex w-full cursor-pointer items-center gap-2 rounded-md border border-line-2/70 bg-bg/60 px-2.5 py-1.5 font-mono text-[11px] text-mute transition-colors hover:border-line-2 hover:text-ink"
            >
              <Search className="size-3" aria-hidden />
              Jump to&hellip;
              <Kbd className="ml-auto">⌘K</Kbd>
            </button>
            <SidebarNav />
          </div>
        </div>
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => setHelpOpen(true)}
            className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 font-mono text-[11px] text-mute transition-colors hover:bg-raised/60 hover:text-ink"
          >
            <Keyboard className="size-3.5" aria-hidden />
            Shortcuts
            <Kbd className="ml-auto">?</Kbd>
          </button>
          <UserBlock me={me} />
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
          {/* Password account without GitHub: every station reads empty until
              a GitHub account is connected, so say why once, up top. */}
          {!me.github_connected && (
            <div className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-line-2/70 bg-surface/60 px-4 py-3 text-[0.85rem] text-ink-dim">
              <Lamp tone="hold" />
              GitHub isn&rsquo;t connected — the factory can&rsquo;t reach any repositories yet.
              <a href="/onboarding" className="font-medium text-accent-bright hover:underline">
                Connect GitHub &rarr;
              </a>
            </div>
          )}
          {children}
        </div>
      </main>

      <BottomTabs />
      <ShortcutHelp
        nav={SIDEBAR_NAV}
        open={helpOpen}
        onOpenChange={setHelpOpen}
        onToggle={() => setHelpOpen((prev) => !prev)}
      />
      <CommandPalette nav={SIDEBAR_NAV} open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}
