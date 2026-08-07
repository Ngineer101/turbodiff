import type { InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { cn } from '../../lib/utils.ts';

const fieldClasses =
	'w-full rounded-md border border-line-2 bg-surface px-2.5 py-1.5 text-sm text-ink placeholder:text-mute/70 read-only:opacity-60 focus-visible:border-accent/50';

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
	return <input className={cn(fieldClasses, className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
	return <textarea className={cn(fieldClasses, 'min-h-40 resize-y leading-relaxed', className)} {...props} />;
}

// Native select, styled to match — no popover dependency needed for the few
// pickers in the app.
export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
	return <select className={cn(fieldClasses, 'appearance-auto', className)} {...props} />;
}

export function Field({
	label,
	hint,
	children,
}: {
	label: string;
	hint?: string;
	children: React.ReactNode;
}) {
	return (
		<label className="mt-4 block text-xs text-mute">
			{label} {hint ? <span className="text-mute/70">({hint})</span> : null}
			<div className="mt-1">{children}</div>
		</label>
	);
}
