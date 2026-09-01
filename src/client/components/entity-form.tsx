import type { FormEvent, ReactNode } from 'react';
import { cn } from '../lib/utils.ts';
import { EntityIcon, type EntityKind } from './ui/entity-icon.tsx';

// The small uppercase label that heads a form section (and the preview rail).
export function FormLabel({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <p
      className={cn(
        'font-mono text-[10px] font-medium tracking-[0.16em] text-mute uppercase',
        className,
      )}
    >
      {children}
    </p>
  );
}

// A labelled group of fields inside a panel — replaces the old flat stack so
// related inputs read as one unit. Fields inside should pass `className="mt-0"`
// (the panel supplies the rhythm via space-y).
export function FormSection({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <section>
      <FormLabel className="mb-2">{label}</FormLabel>
      <div className="space-y-4 rounded-xl border border-line bg-surface/60 p-4 sm:p-5">
        {children}
      </div>
    </section>
  );
}

// Shared create/edit scaffold for agents, skills, and automations: an
// icon+context header over a single column of grouped field sections. `back`
// is a typed Link the caller provides.
export function EntityFormLayout({
  kind,
  title,
  subtitle,
  back,
  onSubmit,
  children,
}: {
  kind: EntityKind;
  title: string;
  subtitle?: ReactNode;
  back?: ReactNode;
  onSubmit: (e: FormEvent) => void;
  children: ReactNode;
}) {
  return (
    <form onSubmit={onSubmit} className="animate-rise max-w-3xl">
      {back}
      <div className="mt-2 flex items-start gap-3">
        <EntityIcon kind={kind} size="lg" />
        <div className="min-w-0">
          <h1 className="text-xl leading-tight font-medium tracking-wide">{title}</h1>
          {subtitle ? (
            <p className="mt-1 text-[0.85rem] leading-relaxed text-mute">{subtitle}</p>
          ) : null}
        </div>
      </div>

      <div className="mt-6 space-y-6">{children}</div>
    </form>
  );
}
