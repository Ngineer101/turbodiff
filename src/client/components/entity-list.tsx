import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/utils.ts';
import { EntityIcon, type EntityKind } from './ui/entity-icon.tsx';

// Shared header for the agents / skills / automations list pages: the type
// icon + title + one-line description on the left, the primary "New" action
// (a button-styled Link, passed in typed by the caller) on the right.
export function EntityListHeader({
  kind,
  title,
  description,
  action,
}: {
  kind: EntityKind;
  title: string;
  description: ReactNode;
  action: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
      <div className="flex items-start gap-3">
        <EntityIcon kind={kind} size="md" />
        <div className="min-w-0">
          <h1 className="text-xl leading-tight font-medium tracking-wide">{title}</h1>
          <p className="mt-1 max-w-2xl text-[0.85rem] leading-relaxed text-mute">{description}</p>
        </div>
      </div>
      {action}
    </div>
  );
}

// Presentational entity card — icon tile, name + chips, description, and
// type-specific meta. Lists wrap it in a typed Link (interactive); forms reuse
// it as a static live preview. The 2-col grid lives on the list pages.
export function EntityCard({
  kind,
  slug,
  name,
  chips,
  description,
  meta,
  interactive = false,
  trailing,
  className,
}: {
  kind: EntityKind;
  slug: string;
  name: string;
  chips?: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  interactive?: boolean;
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex h-full items-start gap-3 rounded-lg border border-line-2 bg-surface p-4 shadow-sticker',
        interactive && 'transition-colors hover:border-accent/50',
        className,
      )}
    >
      <EntityIcon kind={kind} slug={slug} name={name} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[0.9rem] font-medium">
            {name || <span className="text-mute">Untitled</span>}
          </span>
          {chips}
        </div>
        {description ? (
          <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-mute">{description}</p>
        ) : null}
        {meta ? (
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-mute">
            {meta}
          </div>
        ) : null}
      </div>
      {interactive ? (
        <ChevronRight className="size-4 shrink-0 self-center text-mute/60" aria-hidden />
      ) : (
        trailing
      )}
    </div>
  );
}

// The responsive 2-col grid the cards sit in.
export function EntityGrid({ children }: { children: ReactNode }) {
  return <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">{children}</div>;
}
