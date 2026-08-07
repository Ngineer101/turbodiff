import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils.ts';

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
	return (
		<div
			className={cn('rounded-lg border border-line bg-surface p-4', className)}
			{...props}
		/>
	);
}
