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

export const FILE_STATUS_DOT: Record<string, string> = {
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

  const renderDir = (node: DirNode, depth: number) => {
    const closed = closedDirs.has(node.path);
    return (
      <li key={node.path}>
        <button
          type="button"
          onClick={() => toggleDir(node.path)}
          aria-expanded={!closed}
          className="flex w-full cursor-pointer items-center gap-1 rounded px-1.5 py-1 text-left text-xs text-mute hover:bg-raised/60 hover:text-ink"
          style={{ paddingLeft: `${depth * 0.75 + 0.375}rem` }}
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
        {closed ? null : renderChildren(node, depth + 1)}
      </li>
    );
  };

  const renderChildren = (node: DirNode, depth: number) => (
    <ul>
      {node.dirs.map((d) => renderDir(d, depth))}
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
                'flex w-full cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs transition-colors',
                active
                  ? 'bg-raised text-accent-bright'
                  : 'text-ink-dim hover:bg-raised/60 hover:text-ink',
              )}
              style={{ paddingLeft: `${depth * 0.75 + 0.375}rem` }}
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
                <span className="ml-auto flex shrink-0 items-center gap-0.5 text-mute">
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
      {renderChildren(tree, 0)}
    </nav>
  );
}
