import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils.ts';

export const buttonVariants = cva(
  'inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-[color,background-color,border-color,transform,translate,box-shadow] duration-120 ease-out disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        // Keep the 1px paper edge steady on hover; pressing travels into it.
        default:
          'bg-accent font-semibold text-accent-ink shadow-edge hover:bg-accent-bright active:translate-x-px active:translate-y-px active:shadow-none',
        secondary:
          'border border-line-2 bg-transparent text-ink hover:border-accent hover:bg-raised active:scale-[0.97]',
        danger:
          'border border-danger/40 bg-transparent text-danger hover:bg-danger/10 active:scale-[0.97]',
        ghost: 'text-mute hover:bg-raised hover:text-ink active:scale-[0.97]',
      },
      // Mobile floors: every button reaches a comfortable thumb target on
      // touch widths without changing the compact desktop density.
      size: {
        default: 'px-4 py-1.5 text-[0.85rem] max-sm:min-h-11',
        sm: 'px-2.5 py-1 text-xs max-sm:min-h-10 max-sm:px-3.5',
        icon: 'size-8 max-sm:size-11',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  loading?: boolean;
}

export function Button({
  className,
  variant,
  size,
  loading,
  children,
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
      {children}
    </button>
  );
}
