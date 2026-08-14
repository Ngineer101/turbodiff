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
      <div className="font-mono text-[10px] tracking-[0.14em] text-mute uppercase">{label}</div>
      <div className="mt-1 font-mono text-2xl font-semibold tabular-nums">{value}</div>
      <div className="mt-0.5 min-h-4 text-xs text-mute">{sub ?? ' '}</div>
    </Card>
  );
}
