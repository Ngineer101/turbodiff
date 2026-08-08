import type { ReactNode } from 'react';
import { cn } from '../lib/utils.ts';

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
		<div className={cn('mt-9 mb-3 flex flex-wrap items-baseline justify-between gap-2', className)}>
			<h2 className="text-xs font-medium tracking-[0.14em] text-mute uppercase">{children}</h2>
			{aside}
		</div>
	);
}

export function PageTitle({
	children,
	aside,
	titleClassName,
}: {
	children: ReactNode;
	aside?: ReactNode;
	titleClassName?: string;
}) {
	return (
		<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
			<h1
				className={cn(
					'min-w-0 text-lg leading-snug font-medium tracking-wide break-words sm:text-xl',
					titleClassName,
				)}
			>
				{children}
			</h1>
			{aside}
		</div>
	);
}

export function EmptyState({ children }: { children: ReactNode }) {
	return (
		<p className="rounded-xl bg-surface-2/60 px-4 py-8 text-center text-[0.85rem] text-mute">
			{children}
		</p>
	);
}

export function Muted({ children, className }: { children: ReactNode; className?: string }) {
	return <span className={cn('text-[0.85rem] text-mute', className)}>{children}</span>;
}
