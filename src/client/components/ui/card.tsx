import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils.ts';

// The sticker card: a bordered surface with a hard offset shadow. Depth lives
// here and nowhere else — panels and empty states stay flat.
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-lg border border-line-2 bg-surface p-4 shadow-sticker', className)}
      {...props}
    />
  );
}
