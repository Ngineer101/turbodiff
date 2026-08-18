import { ChevronDown, ChevronRight, MessageSquare } from 'lucide-react';
import { useMemo, useState } from 'react';
import { cn } from '../lib/utils.ts';

// Sidebar navigation for the cockpit diff: the changed files as a nested
// tree. Single-child directory chains are compressed into one row
// ("src/client/components"), like GitHub's file tree.

export interface TreeFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
}

interface DirNode {
  name: string; // display segment, possibly a compressed "a/b/c" chain
  path: string; // full path prefix, used as the collapse key
  dirs: DirNode[];
  files: TreeFile[];
}

function buildTree(files: TreeFile[]): DirNode {
  const root: DirNode = { name: '', path: '', dirs: [], files: [] };
  for (const file of files) {
    const segments = file.filename.split('/');
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      let child = node.dirs.find((d) => d.name === segment);
      if (!child) {
        child = {
          name: segment,
          path: node.path ? `${node.path}/${segment}` : segment,
          dirs: [],
          files: [],
        };
        node.dirs.push(child);
      }
      node = child;
    }
    node.files.push(file);
  }
  const compress = (node: DirNode): void => {
    while (node.dirs.length === 1 && node.files.length === 0) {
      const only = node.dirs[0];
      node.name = node.name ? `${node.name}/${only.name}` : only.name;
      node.path = only.path;
      node.dirs = only.dirs;
      node.files = only.files;
    }
    node.dirs.forEach(compress);
  };
  root.dirs.forEach(compress);
  return root;
}

// Named owner contract for the status→dot-class map: statuses come off the
// GitHub diff as open strings (it emits more than the four we color), so
// unknown values intentionally miss and fall through to the caller's default.
interface FileStatusDotClasses {
  readonly [status: string]: string;
}

export const FILE_STATUS_DOT: FileStatusDotClasses = {
  added: 'bg-accent-bright',
  removed: 'bg-danger',
  modified: 'bg-warn',
  renamed: 'bg-mute',
};

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function FileTree({
  files,
  activeFile,
  commentCounts,
  onSelect,
}: {
  files: TreeFile[];
  activeFile: string | null;
  commentCounts: Map<string, number>;
  onSelect: (filename: string) => void;
}) {
  const tree = useMemo(() => buildTree(files), [files]);
  const [closedDirs, setClosedDirs] = useState<Set<string>>(new Set());

  const toggleDir = (path: string) =>
    setClosedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const renderDir = (node: DirNode) => {
    const closed = closedDirs.has(node.path);
    return (
      <li key={node.path}>
        <button
          type="button"
          onClick={() => toggleDir(node.path)}
          aria-expanded={!closed}
          className="flex w-full cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-left text-xs text-mute transition-colors hover:bg-raised/60 hover:text-ink"
        >
          {closed ? (
            <ChevronRight className="size-3 shrink-0" aria-hidden />
          ) : (
            <ChevronDown className="size-3 shrink-0" aria-hidden />
          )}
          <span className="truncate" title={node.path}>
            {node.name}
          </span>
        </button>
        {closed ? null : renderChildren(node, false)}
      </li>
    );
  };

  // Nesting is structural: each level is an indented <ul> with a guide line,
  // so the hierarchy stays readable in deep trees.
  const renderChildren = (node: DirNode, root: boolean) => (
    <ul
      className={cn('flex flex-col gap-px', !root && 'ml-[0.6875rem] border-l border-line/70 pl-1')}
    >
      {node.dirs.map((d) => renderDir(d))}
      {node.files.map((f) => {
        const active = f.filename === activeFile;
        const comments = commentCounts.get(f.filename) ?? 0;
        return (
          <li key={f.filename}>
            <button
              type="button"
              onClick={() => onSelect(f.filename)}
              aria-current={active ? 'true' : undefined}
              className={cn(
                'flex w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs transition-colors',
                active
                  ? 'bg-accent/10 font-medium text-accent-bright'
                  : 'text-ink-dim hover:bg-raised/60 hover:text-ink',
              )}
              title={`${f.filename} (${f.status})`}
            >
              <span
                className={cn(
                  'size-1.5 shrink-0 rounded-full',
                  FILE_STATUS_DOT[f.status] ?? 'bg-mute',
                )}
                aria-hidden
              />
              <span className="truncate">{basename(f.filename)}</span>
              {comments > 0 ? (
                <span
                  className={cn(
                    'ml-auto flex shrink-0 items-center gap-0.5',
                    active ? 'text-accent-bright/80' : 'text-mute',
                  )}
                >
                  <MessageSquare className="size-3" aria-hidden />
                  {comments}
                </span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );

  return (
    <nav aria-label="Changed files" className="font-mono">
      {renderChildren(tree, true)}
    </nav>
  );
}
