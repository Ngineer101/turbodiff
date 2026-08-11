import { Link, useRouterState } from '@tanstack/react-router';
import { BarChart2, Bot, LayoutDashboard, LogOut, Plug, Settings } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/utils.ts';

const NAV = [
  { to: '/', label: 'board', icon: LayoutDashboard, exact: true },
  { to: '/agents', label: 'agents', icon: Bot },
  { to: '/integrations', label: 'integrations', icon: Plug },
  { to: '/usage', label: 'usage', icon: BarChart2 },
  { to: '/settings', label: 'settings', icon: Settings },
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
    <nav aria-label="Main" className="flex flex-col gap-1">
      {NAV.map(({ to, label, icon: Icon, ...item }) => {
        const active = isActive(pathname, to, 'exact' in item && item.exact);
        return (
          <Link
            key={to}
            to={to}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex items-center gap-2.5 rounded-md px-3 py-1.5 text-[0.85rem] transition-colors',
              active
                ? 'bg-raised text-accent-bright'
                : 'text-mute hover:bg-raised/60 hover:text-ink',
            )}
          >
            <Icon className="size-4 shrink-0" aria-hidden />
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
      <div className="grid grid-cols-5">
        {NAV.map(({ to, label, icon: Icon, ...item }) => {
          const active = isActive(pathname, to, 'exact' in item && item.exact);
          return (
            <Link
              key={to}
              to={to}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex flex-col items-center gap-1 py-2 text-[10px] tracking-wide transition-colors active:scale-95',
                active ? 'text-accent-bright' : 'text-mute',
              )}
            >
              <Icon
                className={cn('size-5', active && 'drop-shadow-[0_0_6px_rgba(86,211,100,0.4)]')}
                aria-hidden
              />
              {label}
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
          sign out
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
        <div
          className={cn(
            'mx-auto px-4 py-5 pb-28 sm:py-8 md:px-8 md:pb-8',
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
