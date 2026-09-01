import type { ReactNode } from 'react';
import { cn } from '../../lib/utils.ts';

// One bounded, consistent container for a page section — used instead of a
// flat stack of loose lines so every screen shares the same rhythm. Shared by
// the task page and the cockpit.
export function Panel({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn('rounded-xl border border-line bg-surface/60 p-4 sm:p-5', className)}>
      {children}
    </div>
  );
}

// The small mono uppercase label that heads a panel or rail block.
export function BlockLabel({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <p
      className={cn(
        'font-mono text-[10px] font-medium tracking-[0.16em] text-mute uppercase',
        className,
      )}
    >
      {children}
    </p>
  );
}
