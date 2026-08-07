import type { ReactNode } from 'react';
import { cn } from '../lib/utils.ts';

// '// heading' section marker — the v1 identity, now a component.
export function SectionHeading({
	children,
	aside,
	className,
}: {
	children: ReactNode;
	aside?: ReactNode;
	className?: string;
}) {
	return (
		<div className={cn('mt-9 mb-2 flex flex-wrap items-baseline justify-between gap-2', className)}>
			<h2 className="section-mark text-[0.95rem] font-medium text-ink-dim">{children}</h2>
			{aside}
		</div>
	);
}

export function PageTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
	return (
		<div className="flex flex-wrap items-center justify-between gap-3">
			<h1 className="text-xl font-medium tracking-wide">{children}</h1>
			{aside}
		</div>
	);
}

export function EmptyState({ children }: { children: ReactNode }) {
	return (
		<p className="rounded-lg border border-dashed border-line-2 px-4 py-6 text-center text-[0.85rem] text-mute">
			{children}
		</p>
	);
}

export function Muted({ children, className }: { children: ReactNode; className?: string }) {
	return <span className={cn('text-[0.85rem] text-mute', className)}>{children}</span>;
}
