import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cn } from '../../lib/utils.ts';

export function Table({ className, ...props }: HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="overflow-x-auto">
      <table className={cn('mt-2 w-full border-collapse', className)} {...props} />
    </div>
  );
}

export function Th({
  className,
  numeric,
  ...props
}: ThHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return (
    <th
      className={cn(
        'px-1.5 pb-1 text-left text-xs font-normal text-mute',
        numeric && 'text-right',
        className,
      )}
      {...props}
    />
  );
}

export function Td({
  className,
  numeric,
  ...props
}: TdHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return (
    <td
      className={cn(
        'border-t border-line px-1.5 py-2 align-top',
        numeric && 'text-right tabular-nums whitespace-nowrap',
        className,
      )}
      {...props}
    />
  );
}
