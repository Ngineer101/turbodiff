import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils.ts';

// The v1 status pill, kept as the app's core status vocabulary. `running`
// prefixes a pulsing dot. Tones follow the colour rule: `on` is green
// (success), `running` is yellow (live), `accent` is yellow without the dot
// (a recommendation, something to pick).
const pillVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-2.5 py-px font-mono text-xs whitespace-nowrap',
  {
    variants: {
      tone: {
        neutral: 'border-line-2 bg-raised/50 text-mute',
        on: 'border-go/30 bg-go/10 text-go-bright',
        running: 'border-hold/30 bg-hold/10 text-hold',
        accent: 'border-accent/30 bg-accent/10 text-accent',
        red: 'border-danger/30 bg-danger/10 text-danger',
        warn: 'border-warn/30 bg-warn/10 text-warn',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export interface PillProps
  extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof pillVariants> {}

export function Pill({ className, tone, children, ...props }: PillProps) {
  return (
    <span className={cn(pillVariants({ tone }), className)} {...props}>
      {tone === 'running' ? (
        <span className="animate-pulse-dot" aria-hidden>
          ●
        </span>
      ) : null}
      {children}
    </span>
  );
}
