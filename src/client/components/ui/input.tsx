import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils.ts';

// text-base below sm is deliberate: iOS Safari auto-zooms any focused field
// with a font size under 16px.
const fieldClasses =
  'w-full rounded-lg border border-line-2/70 bg-surface px-3 py-2 text-base text-ink placeholder:text-mute/70 read-only:opacity-60 focus-visible:border-accent/50 sm:rounded-md sm:px-2.5 sm:py-1.5 sm:text-sm';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cn(fieldClasses, className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(fieldClasses, 'min-h-40 resize-y leading-relaxed', className)}
      {...props}
    />
  );
}

// Native select, styled to match — no popover dependency needed for the few
// pickers in the app.
export function Select({ className, ...props }: ComponentProps<'select'>) {
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
