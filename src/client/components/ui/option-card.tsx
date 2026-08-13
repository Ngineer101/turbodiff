import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/utils.ts';
import { Pill } from './pill.tsx';

const optionCardVariants = cva(
  'w-full cursor-pointer rounded-xl border px-3.5 py-3 text-left text-[0.85rem] transition-colors',
  {
    variants: {
      selected: {
        true: 'border-accent bg-accent/10 text-ink',
        false: 'border-line-2/70 bg-surface text-ink hover:border-accent/40 hover:bg-raised',
      },
    },
    defaultVariants: { selected: false },
  },
);

export function OptionCard({
  selected,
  recommended,
  children,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof optionCardVariants> & { recommended?: boolean; children: ReactNode }) {
  return (
    <button type="button" className={cn(optionCardVariants({ selected }), className)} {...props}>
      <div className="flex items-start justify-between gap-2">
        <span>{children}</span>
        {recommended ? <Pill tone="on">Recommended</Pill> : null}
      </div>
    </button>
  );
}
