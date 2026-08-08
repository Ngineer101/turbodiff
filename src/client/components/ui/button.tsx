import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils.ts';

const buttonVariants = cva(
	'inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-[color,background-color,border-color,transform] active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50',
	{
		variants: {
			variant: {
				default:
					'border border-accent-bright/40 bg-accent text-accent-ink hover:bg-accent-bright',
				secondary: 'border border-line-2 bg-transparent text-ink hover:border-accent/40 hover:bg-raised',
				danger: 'border border-danger/40 bg-transparent text-danger hover:bg-danger/10',
				ghost: 'text-mute hover:bg-raised hover:text-ink',
			},
			size: {
				default: 'px-4 py-1.5 text-[0.85rem]',
				sm: 'px-2.5 py-1 text-xs',
				icon: 'size-8',
			},
		},
		defaultVariants: { variant: 'default', size: 'default' },
	},
);

export interface ButtonProps
	extends ButtonHTMLAttributes<HTMLButtonElement>,
		VariantProps<typeof buttonVariants> {
	loading?: boolean;
}

export function Button({ className, variant, size, loading, children, disabled, ...props }: ButtonProps) {
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
