import type { ReactNode } from 'react';
import { cn } from '../../lib/utils.ts';

// Keycap for keyboard shortcuts. The extra-thick bottom border + soft shadow
// give it a physical "key" read so a hint is never mistaken for a badge or
// pill — this is the single source of that styling across the app (sidebar,
// command palette, shortcut cheat-sheet), so keep all shortcut hints on it.
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-[18px] min-w-[18px] items-center justify-center gap-0.5 rounded-[5px]',
        'border border-line-2 border-b-[2.5px] bg-raised px-1.5',
        'font-mono text-[10px] leading-none font-medium text-ink-dim',
        'shadow-[0_1px_1.5px_rgba(0,0,0,0.45)]',
        className,
      )}
    >
      {children}
    </kbd>
  );
}
