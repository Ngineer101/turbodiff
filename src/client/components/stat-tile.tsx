import type { ReactNode } from 'react';
import { Card } from './ui/card.tsx';

export function StatTile({
	label,
	value,
	sub,
	index = 0,
}: {
	label: string;
	value: ReactNode;
	sub?: ReactNode;
	index?: number;
}) {
	return (
		<Card className="animate-rise" style={{ animationDelay: `${index * 60}ms` }}>
			<div className="text-xs text-mute">{label}</div>
			<div className="mt-0.5 text-2xl font-semibold tabular-nums">{value}</div>
			<div className="mt-0.5 min-h-4 text-xs text-mute">{sub ?? ' '}</div>
		</Card>
	);
}
