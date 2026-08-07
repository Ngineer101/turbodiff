import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils.ts';

// The v1 status pill, kept as the app's core status vocabulary. `running`
// prefixes a pulsing dot.
const pillVariants = cva(
	'inline-flex items-center gap-1 rounded-full border px-2.5 py-px text-xs whitespace-nowrap',
	{
		variants: {
			tone: {
				neutral: 'border-line-2 text-mute',
				on: 'border-accent/40 text-accent-bright',
				running: 'border-accent/40 text-accent-bright',
				red: 'border-danger/40 text-danger',
				warn: 'border-warn/40 text-warn',
			},
		},
		defaultVariants: { tone: 'neutral' },
	},
);

export interface PillProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof pillVariants> {}

export function Pill({ className, tone, children, ...props }: PillProps) {
	return (
		<span className={cn(pillVariants({ tone }), className)} {...props}>
			{tone === 'running' ? <span className="animate-pulse-dot" aria-hidden>●</span> : null}
			{children}
		</span>
	);
}
