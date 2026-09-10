import type { ReactNode } from 'react';
import { cn } from '../../lib/utils.ts';

// Keycap for keyboard shortcuts. A quiet bordered chip — the single source of
// shortcut-hint styling across the app (sidebar, command palette, shortcut
// cheat-sheet), so keep all shortcut hints on it.
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-[18px] min-w-[18px] items-center justify-center gap-0.5 rounded-[5px]',
        'border border-line-2 bg-raised px-1.5',
        'font-mono text-[10px] leading-none font-medium text-ink-dim',
        className,
      )}
    >
      {children}
    </kbd>
  );
}
