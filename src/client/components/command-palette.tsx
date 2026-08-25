import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { CornerDownLeft, FolderGit2, LayoutDashboard, Ticket } from 'lucide-react';
import { useMemo, useState, type ComponentType } from 'react';
import { boardQuery } from '../lib/queries.ts';
import { onListboxKeyDown } from '../lib/shortcuts.ts';
import { cn } from '../lib/utils.ts';
import { Serial } from './identity.tsx';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog.tsx';
import { Input } from './ui/input.tsx';
import { Kbd } from './ui/kbd.tsx';

// ⌘K jump palette: every station, task, and repo one keystroke away. Board
// data loads lazily on first open (and is usually already cached from the
// board itself); navigation-only, so selecting can never destroy anything.

type Item = {
  key: string;
  label: string;
  hint?: string;
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  serial?: number;
  go: () => void;
};

type SectionDef = { title: string; items: Item[] };

export function CommandPalette({
  open,
  onOpenChange,
  nav,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  nav: readonly { to: string; label: string }[];
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const board = useQuery({ ...boardQuery, enabled: open });

  const close = () => {
    onOpenChange(false);
    setQuery('');
  };
  const go = (fn: () => void) => {
    close();
    fn();
  };

  const sections = useMemo<SectionDef[]>(() => {
    const q = query.trim().toLowerCase();
    const match = (text: string) => !q || text.toLowerCase().includes(q);
    const pages: Item[] = nav
      .filter((item) => match(item.label))
      .map((item) => ({
        key: `nav:${item.to}`,
        label: item.label,
        icon: LayoutDashboard,
        go: () => void navigate({ to: item.to }),
      }));
    const tasks: Item[] = (board.data?.tasks ?? [])
      .filter((task) => match(task.title) || match(`td-${String(task.id).padStart(4, '0')}`))
      .slice(0, 8)
      .map((task) => ({
        key: `task:${task.id}`,
        label: task.title,
        serial: task.id,
        icon: Ticket,
        go: () => void navigate({ to: '/tasks/$taskId', params: { taskId: String(task.id) } }),
      }));
    const repos: Item[] = (board.data?.repos ?? [])
      .filter((repo) => match(`${repo.owner}/${repo.name}`))
      .slice(0, 8)
      .map((repo) => ({
        key: `repo:${repo.id}`,
        label: `${repo.owner}/${repo.name}`,
        hint: 'code',
        icon: FolderGit2,
        go: () =>
          void navigate({
            to: '/repos/$repoId/code/$',
            params: { repoId: String(repo.id), _splat: '' },
          }),
      }));
    return [
      { title: 'Go to', items: pages },
      { title: 'Tasks', items: tasks },
      { title: 'Repositories · code', items: repos },
    ].filter((section) => section.items.length > 0);
  }, [query, nav, board.data, navigate]);

  const first = sections[0]?.items[0];

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="top-24 max-w-lg translate-y-0 p-3" onKeyDown={onListboxKeyDown}>
        <DialogTitle className="sr-only">Jump to</DialogTitle>
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Enter takes the top result while typing; arrows (handled by
            // the listbox hook on the dialog) move focus into the results.
            if (e.key === 'Enter' && first) {
              e.preventDefault();
              go(first.go);
            }
          }}
          placeholder="Jump to a page, task, or repository…"
          aria-label="Jump to"
          className="font-mono text-xs sm:text-xs"
        />
        <div className="mt-2 max-h-80 overflow-y-auto" role="listbox" aria-label="Results">
          {sections.map((section) => (
            <div key={section.title}>
              <p className="px-2 pt-2 pb-1 font-mono text-[10px] tracking-[0.14em] text-mute uppercase">
                {section.title}
              </p>
              {section.items.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  role="option"
                  aria-selected={item === first}
                  onClick={() => go(item.go)}
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[0.85rem] transition-colors',
                    'text-ink-dim hover:bg-raised/60 hover:text-ink focus:bg-raised/60 focus:text-ink focus:outline-none',
                  )}
                >
                  <item.icon className="size-3.5 shrink-0 text-mute" aria-hidden />
                  {item.serial !== undefined ? <Serial n={item.serial} /> : null}
                  <span className="min-w-0 truncate">{item.label}</span>
                  {item.hint ? (
                    <span className="ml-auto font-mono text-[10px] text-mute">{item.hint}</span>
                  ) : null}
                  {item === first ? (
                    <Kbd className={cn(item.hint === undefined && 'ml-auto')}>
                      <CornerDownLeft className="size-2.5" aria-hidden />
                    </Kbd>
                  ) : null}
                </button>
              ))}
            </div>
          ))}
          {sections.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-mute">
              Nothing matches &ldquo;{query}&rdquo;
            </p>
          ) : null}
          {board.isPending && open ? (
            <p className="px-2 py-1.5 text-xs text-mute" role="status">
              Loading tasks and repositories&hellip;
            </p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
