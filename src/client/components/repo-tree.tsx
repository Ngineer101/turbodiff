import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import type { ApiTreeEntry } from '../../shared/api-types.ts';
import { repoTreeQuery } from '../lib/queries.ts';
import { cn } from '../lib/utils.ts';

// Lazy-loading directory tree for the code browser: each expanded directory
// fetches its own one-level listing (queries cache per path, so collapse and
// re-expand is free). Deliberately separate from file-tree.tsx — that one is
// cockpit-specific (diff stats, comment counts); only the visual language is
// shared.

export function RepoTree({
  repoId,
  treeRef,
  activePath,
  onSelectFile,
}: {
  repoId: number;
  // The branch (git ref) — named treeRef because `ref` is reserved in React.
  treeRef: string;
  activePath: string | null;
  onSelectFile: (path: string) => void;
}) {
  return (
    <nav aria-label="Repository files" className="font-mono">
      <DirContents
        repoId={repoId}
        treeRef={treeRef}
        path=""
        root
        activePath={activePath}
        onSelectFile={onSelectFile}
      />
    </nav>
  );
}

function DirContents({
  repoId,
  treeRef,
  path,
  root = false,
  activePath,
  onSelectFile,
}: {
  repoId: number;
  treeRef: string;
  path: string;
  root?: boolean;
  activePath: string | null;
  onSelectFile: (path: string) => void;
}) {
  const { data, isPending, isError } = useQuery(repoTreeQuery(repoId, treeRef, path));
  const indent = !root && 'ml-[0.6875rem] border-l border-line/70 pl-1';
  if (isPending) {
    return (
      <p className={cn('px-1.5 py-1 text-xs text-mute', indent)} role="status">
        Loading<span className="animate-cursor text-accent-bright">_</span>
      </p>
    );
  }
  if (isError) {
    return <p className={cn('px-1.5 py-1 text-xs text-danger', indent)}>Failed to load</p>;
  }
  return (
    <ul className={cn('flex flex-col gap-px', indent)}>
      {data.entries.map((entry) => (
        <EntryRow
          key={entry.path}
          repoId={repoId}
          treeRef={treeRef}
          entry={entry}
          activePath={activePath}
          onSelectFile={onSelectFile}
        />
      ))}
    </ul>
  );
}

function EntryRow({
  repoId,
  treeRef,
  entry,
  activePath,
  onSelectFile,
}: {
  repoId: number;
  treeRef: string;
  entry: ApiTreeEntry;
  activePath: string | null;
  onSelectFile: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (entry.type === 'dir') {
    return (
      <li>
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          aria-expanded={open}
          className="flex w-full cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-left text-xs text-mute transition-colors hover:bg-raised/60 hover:text-ink"
        >
          {open ? (
            <ChevronDown className="size-3 shrink-0" aria-hidden />
          ) : (
            <ChevronRight className="size-3 shrink-0" aria-hidden />
          )}
          <span className="truncate" title={entry.path}>
            {entry.name}
          </span>
        </button>
        {open ? (
          <DirContents
            repoId={repoId}
            treeRef={treeRef}
            path={entry.path}
            activePath={activePath}
            onSelectFile={onSelectFile}
          />
        ) : null}
      </li>
    );
  }
  // Symlinks and submodules have nothing to open here — inert muted rows.
  if (entry.type !== 'file') {
    return (
      <li>
        <span
          className="flex items-center gap-1.5 px-1.5 py-1 text-xs text-mute/60"
          title={`${entry.path} (${entry.type})`}
        >
          <span className="truncate">{entry.name}</span>
        </span>
      </li>
    );
  }
  const active = entry.path === activePath;
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelectFile(entry.path)}
        aria-current={active ? 'true' : undefined}
        className={cn(
          'flex w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs transition-colors',
          active
            ? 'bg-accent/10 font-medium text-accent-bright'
            : 'text-ink-dim hover:bg-raised/60 hover:text-ink',
        )}
        title={entry.path}
      >
        <span className="truncate">{entry.name}</span>
      </button>
    </li>
  );
}
