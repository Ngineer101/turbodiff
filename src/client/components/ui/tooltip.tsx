import type { ReactNode } from 'react';
import { cn } from '../../lib/utils.ts';

// Lightweight, dependency-free tooltip for icon-only controls: reveals a label
// on hover and keyboard focus, no JS. The trigger must carry its own
// `aria-label` — that's the accessible name; this label is the visual
// affordance for pointer users. CSS-positioned (not collision-aware), so keep
// labels short and choose a `side` that won't run off-screen.
export function Tooltip({
  label,
  side = 'top',
  children,
  className,
}: {
  label: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
  children: ReactNode;
  className?: string;
}) {
  const pos = {
    top: 'bottom-full left-1/2 mb-1.5 -translate-x-1/2',
    bottom: 'top-full left-1/2 mt-1.5 -translate-x-1/2',
    left: 'right-full top-1/2 mr-1.5 -translate-y-1/2',
    right: 'left-full top-1/2 ml-1.5 -translate-y-1/2',
  }[side];
  return (
    <span className={cn('group relative inline-flex', className)}>
      {children}
      <span
        role="tooltip"
        className={cn(
          'pointer-events-none absolute z-50 whitespace-nowrap rounded-md border border-line-2 bg-raised px-2 py-1 font-mono text-[10.5px] text-ink-dim opacity-0 shadow-lg shadow-black/50 transition-opacity duration-100',
          'group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none',
          pos,
        )}
      >
        {label}
      </span>
    </span>
  );
}
