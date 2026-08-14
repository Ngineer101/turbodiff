import { Link, useRouterState } from '@tanstack/react-router';
import { LogOut } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/utils.ts';
import { Lamp } from './identity.tsx';

// Control-room nav: every destination is a station with an indicator lamp —
// lit where you are, dark elsewhere. No icon set; the placard type IS the
// iconography.
const NAV = [
  { to: '/', label: 'Board', exact: true },
  { to: '/agents', label: 'Agents' },
  { to: '/skills', label: 'Skills' },
  { to: '/automations', label: 'Automations' },
  { to: '/integrations', label: 'Integrations' },
  { to: '/usage', label: 'Usage' },
  { to: '/settings', label: 'Settings' },
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
      {NAV.map(({ to, label, ...item }) => {
        const active = isActive(pathname, to, 'exact' in item && item.exact);
        return (
          <Link
            key={to}
            to={to}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex items-center gap-2.5 rounded-md border-l-2 px-3 py-[7px] font-mono text-[11px] tracking-[0.14em] uppercase transition-colors',
              active
                ? 'border-accent-bright bg-surface text-ink'
                : 'border-transparent text-mute hover:bg-surface/60 hover:text-ink-dim',
            )}
          >
            <Lamp tone={active ? 'go' : 'off'} />
            {label}
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
        {NAV.map(({ to, label, ...item }) => {
          const active = isActive(pathname, to, 'exact' in item && item.exact);
          return (
            <Link
              key={to}
              to={to}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex min-w-0 flex-1 flex-col items-center gap-1.5 py-2.5 font-mono text-[9px] tracking-[0.08em] uppercase transition-colors active:scale-95',
                active ? 'text-accent-bright' : 'text-mute',
              )}
            >
              <Lamp tone={active ? 'go' : 'off'} className="size-2.5" />
              <span className="max-w-full truncate px-0.5">{label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

function UserBlock({ login }: { login: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="truncate font-mono text-xs text-mute">@{login}</span>
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
export function AppShell({ login, children }: { login: string; children: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const wide = pathname.startsWith('/factory/features/');
  // The board's three lanes need more room than the reading-width default.
  const board = pathname === '/';
  return (
    <div className="min-h-dvh md:flex">
      <aside className="sticky top-0 hidden h-dvh w-52 shrink-0 flex-col justify-between border-r border-line bg-surface/50 p-4 md:flex">
        <div className="space-y-6">
          <Logo />
          <SidebarNav />
        </div>
        <UserBlock login={login} />
      </aside>

      <div className="sticky top-0 z-40 flex items-center justify-between border-b border-line/60 bg-bg/95 px-4 py-2.5 backdrop-blur md:hidden">
        <Logo />
        <UserBlock login={login} />
      </div>

      <main className="min-w-0 flex-1">
        {/* The width change between routes (reading width ↔ wide cockpit)
            eases instead of snapping while the next page is still pending. */}
        <div
          className={cn(
            'mx-auto px-4 py-5 pb-28 transition-[max-width] duration-300 ease-out sm:py-8 md:px-8 md:pb-8',
            wide ? 'max-w-[96rem]' : board ? 'max-w-7xl' : 'max-w-4xl',
          )}
        >
          {children}
        </div>
      </main>

      <BottomTabs />
    </div>
  );
}
