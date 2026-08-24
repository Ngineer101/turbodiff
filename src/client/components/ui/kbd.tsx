import type { ReactNode } from 'react';
import { cn } from '../../lib/utils.ts';

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-4 min-w-4 items-center justify-center rounded border border-line-2 bg-raised/70 px-1 font-mono text-[10px] text-mute',
        className,
      )}
    >
      {children}
    </kbd>
  );
}
