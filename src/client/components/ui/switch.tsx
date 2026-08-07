import * as SwitchPrimitive from '@radix-ui/react-switch';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils.ts';

export function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
	return (
		<SwitchPrimitive.Root
			className={cn(
				'inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-line-2 bg-raised transition-colors data-[state=checked]:border-accent/50 data-[state=checked]:bg-accent disabled:cursor-not-allowed disabled:opacity-50',
				className,
			)}
			{...props}
		>
			<SwitchPrimitive.Thumb className="block size-3.5 translate-x-0.5 rounded-full bg-mute transition-transform data-[state=checked]:translate-x-[1.1rem] data-[state=checked]:bg-accent-ink" />
		</SwitchPrimitive.Root>
	);
}
