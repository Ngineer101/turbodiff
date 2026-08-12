import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  Archive,
  Check,
  ChevronDown,
  FolderGit2,
  Paperclip,
  Play,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import type { ApiBoard, ApiPlan, ApiTodo } from '../../shared/api-types.ts';
import { api, ApiError } from '../lib/api.ts';
import { ago, fmtUsd } from '../lib/format.ts';
import { boardQuery } from '../lib/queries.ts';
import { taskColumn, taskState } from '../lib/task-state.ts';
import { cn } from '../lib/utils.ts';
import { ConfirmButton } from '../components/confirm-button.tsx';
import { Muted, PageTitle } from '../components/section.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card } from '../components/ui/card.tsx';
import { Dialog, DialogContent, DialogTitle } from '../components/ui/dialog.tsx';
import { Field, Input, Select, Textarea } from '../components/ui/input.tsx';
import { Pill } from '../components/ui/pill.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover.tsx';

// The home board: To Do (unstarted todos, deletable) → In Progress (started
// tasks — planning through open PR) → Done (merged). Started tasks are only
// ever archived, never deleted.

type ColumnKey = 'todo' | 'in_progress' | 'done';

function onApiError(err: unknown) {
  toast.error(err instanceof ApiError ? err.message : 'request failed');
}

function QuickAdd({ board }: { board: ApiBoard }) {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState('');
  const [installationId, setInstallationId] = useState(board.installations[0]?.id ?? 0);
  // Power-user affordance: "/" focuses the quick-add from anywhere on the board.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const add = useMutation({
    mutationFn: () => api.post('/api/todos', { installation_id: installationId, title }),
    onSuccess: () => {
      setTitle('');
      void queryClient.invalidateQueries({ queryKey: ['board'] });
    },
    onError: onApiError,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (title.trim()) add.mutate();
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row">
      <Input
        ref={inputRef}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="add a todo…  ( / )"
        aria-label="New todo title"
        maxLength={200}
        className="flex-1"
      />
      {board.installations.length > 1 ? (
        <Select
          value={installationId}
          onChange={(e) => setInstallationId(Number(e.target.value))}
          aria-label="Installation"
          className="sm:w-44"
        >
          {board.installations.map((i) => (
            <option key={i.id} value={i.id}>
              {i.account_login}
            </option>
          ))}
        </Select>
      ) : null}
    </form>
  );
}

function StartDialog({
  todo,
  board,
  onClose,
}: {
  todo: ApiTodo;
  board: ApiBoard;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(todo.title);
  const [requirements, setRequirements] = useState(todo.notes ?? todo.title);
  const [files, setFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const start = useMutation({
    // Attachments (pdf/images) upload first, then ride the start payload so
    // the planning agent reads them alongside the requirements.
    mutationFn: async () => {
      const attachments: { key: string; name: string; content_type: string }[] = [];
      for (const file of files) {
        const fd = new FormData();
        fd.append('file', file);
        const res = await fetch('/api/uploads', { method: 'POST', body: fd });
        const data = (await res.json().catch(() => null)) as {
          key?: string;
          name?: string;
          content_type?: string;
          error?: string;
        } | null;
        if (!res.ok || !data?.key) {
          throw new ApiError(data?.error ?? `upload failed for ${file.name}`, res.status);
        }
        attachments.push({
          key: data.key,
          name: data.name ?? file.name,
          content_type: data.content_type ?? file.type,
        });
      }
      return api.post(`/api/todos/${todo.id}/start`, { title, requirements, attachments });
    },
    onSuccess: () => {
      toast.success('task started — the planning agent is on it');
      void queryClient.invalidateQueries({ queryKey: ['board'] });
      onClose();
    },
    onError: onApiError,
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogTitle className="text-base font-medium">Start task</DialogTitle>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (requirements.trim() && todo.repos.length > 0) start.mutate();
          }}
        >
          <Field label="repositories">
            <RepoChips todo={todo} board={board} />
          </Field>
          <Field label="title">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              maxLength={200}
            />
          </Field>
          <Field label="requirements">
            <Textarea
              value={requirements}
              onChange={(e) => setRequirements(e.target.value)}
              required
              className="min-h-28"
              placeholder="What should be built? The planning agent reads the repo and drafts a plan you approve."
            />
          </Field>
          <div className="mt-3">
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf,image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                const picked = Array.from(e.target.files ?? []);
                setFiles((prev) => [...prev, ...picked].slice(0, 5));
                e.target.value = '';
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip className="size-3.5" aria-hidden /> attach files (pdf, images)
            </Button>
            {files.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {files.map((f, i) => (
                  <span
                    key={`${f.name}-${i}`}
                    className="inline-flex items-center gap-1.5 rounded-full bg-raised/70 py-1 pr-1.5 pl-2.5 text-xs"
                  >
                    <span className="max-w-40 truncate">{f.name}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${f.name}`}
                      className="cursor-pointer rounded-full p-0.5 text-mute hover:text-danger"
                      onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                    >
                      <X className="size-3" aria-hidden />
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              loading={start.isPending}
              disabled={todo.repos.length === 0}
              title={todo.repos.length === 0 ? 'select at least one repository first' : undefined}
            >
              Start planning
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// The pre-start repo picker: a popover listing the installation's
// factory-enabled repos, capped at 3 selections. Posts the replace-all
// selection on every toggle so the todo's persisted list (GET /board)
// always reflects it. A todo can't be deselected to zero repos here —
// removing the last one is a no-op, matching the API's guard.
function RepoPickerPopover({ todo, board }: { todo: ApiTodo; board: ApiBoard }) {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');
  const available = board.repos.filter((r) => r.installation_id === todo.installation_id);
  const filtered = query.trim()
    ? available.filter((r) => `${r.owner}/${r.name}`.toLowerCase().includes(query.toLowerCase()))
    : available;
  const selectedIds = todo.repos.map((r) => r.id);
  const setRepos = useMutation({
    mutationFn: (ids: number[]) => api.post(`/api/todos/${todo.id}/repos`, { repository_ids: ids }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['board'] }),
    onError: onApiError,
  });
  const toggle = (id: number) => {
    const selected = selectedIds.includes(id);
    const next = selected ? selectedIds.filter((i) => i !== id) : [...selectedIds, id];
    if (next.length === 0 || next.length > 3) return;
    setRepos.mutate(next);
  };
  return (
    <Popover onOpenChange={(open) => !open && setQuery('')}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex cursor-pointer items-center gap-1 rounded-full border border-dashed border-line-2 px-2 py-0.5 text-xs text-mute transition-colors hover:border-accent/40 hover:text-accent-bright',
          )}
        >
          <Plus className="size-3" aria-hidden />
          {todo.repos.length === 0 ? 'repos' : 'edit'}
        </button>
      </PopoverTrigger>
      <PopoverContent>
        {available.length > 6 ? (
          <div className="relative mb-1.5">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-mute"
              aria-hidden
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="filter repositories…"
              aria-label="Filter repositories"
              className="py-1.5 pl-8 text-xs sm:py-1.5 sm:pl-8"
            />
          </div>
        ) : null}
        <div className="max-h-64 overflow-y-auto" role="listbox" aria-label="Repositories">
          {filtered.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs text-mute">no repositories match</p>
          ) : (
            filtered.map((r) => {
              const selected = selectedIds.includes(r.id);
              const disabled = setRepos.isPending || (!selected && selectedIds.length >= 3);
              return (
                <button
                  key={r.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  disabled={disabled}
                  onClick={() => toggle(r.id)}
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                    selected ? 'text-accent-bright' : 'text-ink-dim hover:bg-raised/70',
                  )}
                >
                  <span className="flex size-4 shrink-0 items-center justify-center">
                    {selected ? <Check className="size-3.5" aria-hidden /> : null}
                  </span>
                  <FolderGit2 className="size-3.5 shrink-0 text-mute" aria-hidden />
                  <span className="min-w-0 truncate">
                    <span className="text-mute">{r.owner}/</span>
                    {r.name}
                  </span>
                </button>
              );
            })
          )}
        </div>
        <p className="mt-1.5 border-t border-line px-2 pt-1.5 text-[11px] text-mute/70">
          {selectedIds.length}/3 selected — a task targets up to 3 repos
        </p>
      </PopoverContent>
    </Popover>
  );
}

function RepoChips({ todo, board }: { todo: ApiTodo; board: ApiBoard }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {todo.repos.map((r) => (
        <span
          key={r.id}
          title={`${r.owner}/${r.name}`}
          className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-raised/70 py-0.5 pr-2.5 pl-2 text-xs text-ink-dim"
        >
          <FolderGit2 className="size-3 shrink-0 text-mute" aria-hidden />
          <span className="truncate">{r.name}</span>
        </span>
      ))}
      <RepoPickerPopover todo={todo} board={board} />
    </div>
  );
}

function TodoCard({ todo, board }: { todo: ApiTodo; board: ApiBoard }) {
  const queryClient = useQueryClient();
  const [starting, setStarting] = useState(false);
  const remove = useMutation({
    mutationFn: () => api.delete(`/api/todos/${todo.id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['board'] }),
    onError: onApiError,
  });
  return (
    <Card className="animate-rise p-3">
      <div className="flex items-start justify-between gap-2">
        <span className="text-[0.85rem] font-medium break-words">{todo.title}</span>
        <ConfirmButton
          variant="ghost"
          size="icon"
          className="size-6 shrink-0 text-mute hover:text-danger"
          title="Delete this todo?"
          description="It hasn't been started, so nothing else is lost."
          confirmLabel="Delete"
          onConfirm={() => remove.mutate()}
          busy={remove.isPending}
          aria-label={`Delete todo ${todo.title}`}
        >
          <Trash2 className="size-3.5" aria-hidden />
        </ConfirmButton>
      </div>
      {todo.notes ? <p className="mt-1 line-clamp-3 text-xs text-mute">{todo.notes}</p> : null}
      <div className="mt-2.5">
        <RepoChips todo={todo} board={board} />
      </div>
      <div className="mt-2.5 flex items-center justify-between">
        <Muted className="text-xs">{ago(todo.created_at)}</Muted>
        <Button size="sm" variant="secondary" onClick={() => setStarting(true)}>
          <Play className="size-3" aria-hidden /> Start
        </Button>
      </div>
      {starting ? (
        <StartDialog todo={todo} board={board} onClose={() => setStarting(false)} />
      ) : null}
    </Card>
  );
}

function TaskCard({ task }: { task: ApiPlan }) {
  const queryClient = useQueryClient();
  const state = taskState(task);
  const archive = useMutation({
    mutationFn: () => api.post(`/api/tasks/${task.id}/archive`, { archived: true }),
    onSuccess: () => {
      toast.success('task archived');
      void queryClient.invalidateQueries({ queryKey: ['board'] });
    },
    onError: onApiError,
  });
  return (
    <Card className="animate-rise p-3 transition-colors hover:border-accent/30">
      <div className="flex items-start justify-between gap-2">
        <Link
          to="/tasks/$taskId"
          params={{ taskId: String(task.id) }}
          className="min-w-0 text-[0.85rem] font-medium break-words hover:text-accent-bright"
        >
          {task.title}
        </Link>
        <ConfirmButton
          variant="ghost"
          size="icon"
          className="size-6 shrink-0 text-mute"
          title="Archive this task?"
          description="Started tasks are never deleted — archiving hides it from the board. The plan, PR, and history stay."
          confirmLabel="Archive"
          onConfirm={() => archive.mutate()}
          busy={archive.isPending}
          aria-label={`Archive task ${task.title}`}
        >
          <Archive className="size-3.5" aria-hidden />
        </ConfirmButton>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
        <Pill tone={state.tone}>{state.label}</Pill>
        {task.repos
          .filter((r) => r.verification && r.feature_status !== 'merged')
          .map((r) => (
            <Pill
              key={r.repository_id}
              tone={
                r.verification!.status === 'passed'
                  ? 'on'
                  : r.verification!.status === 'running'
                    ? 'running'
                    : 'red'
              }
            >
              {r.owner}/{r.name} verify: {r.verification!.status}
            </Pill>
          ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-2 text-xs text-mute">
        <span className="min-w-0 truncate font-mono">
          {task.repos.map((r) => `${r.owner}/${r.name}`).join(', ')}
        </span>
        <span className="shrink-0">{ago(task.created_at)}</span>
      </div>
    </Card>
  );
}

function Column({
  title,
  count,
  children,
  empty,
}: {
  title: string;
  count: number;
  children: ReactNode;
  empty: string;
}) {
  return (
    <section className="min-w-0">
      <h2 className="mb-2.5 font-mono text-xs font-medium tracking-[0.14em] text-mute uppercase">
        {title} <span className="ml-1 text-mute/60">{count}</span>
      </h2>
      <div className="flex flex-col gap-2.5">
        {count === 0 ? (
          <p className="rounded-xl bg-surface-2/60 px-3 py-6 text-center text-xs text-mute">
            {empty}
          </p>
        ) : (
          children
        )}
      </div>
    </section>
  );
}

type FilterRepo = { id: number; owner: string; name: string; count: number };

// Single-select repo filter for the whole board. Options come from the repos
// actually on the cards (not the installation's full repo list), so every
// choice matches at least one card; the count shows what it matches.
function RepoFilter({
  repos,
  value,
  onChange,
}: {
  repos: FilterRepo[];
  value: number | null;
  onChange: (id: number | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const filtered = query.trim()
    ? repos.filter((r) => `${r.owner}/${r.name}`.toLowerCase().includes(query.toLowerCase()))
    : repos;
  const active = repos.find((r) => r.id === value);
  const pick = (id: number | null) => {
    onChange(id);
    setOpen(false);
  };
  const optionClasses = (selected: boolean) =>
    cn(
      'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
      selected ? 'text-accent-bright' : 'text-ink-dim hover:bg-raised/70',
    );
  return (
    <Popover
      open={open}
      onOpenChange={(o: boolean) => {
        setOpen(o);
        if (!o) setQuery('');
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Filter board by repository"
          className={cn(
            'inline-flex cursor-pointer items-center gap-1.5 self-start rounded-lg border bg-surface px-3 py-2 text-xs whitespace-nowrap transition-colors sm:rounded-md sm:py-1.5',
            active
              ? 'border-accent/40 text-accent-bright'
              : 'border-line-2/70 text-mute hover:text-ink',
          )}
        >
          <FolderGit2 className="size-3.5 shrink-0" aria-hidden />
          <span className="max-w-44 truncate">{active ? active.name : 'all repos'}</span>
          <ChevronDown className="size-3.5 shrink-0 opacity-60" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end">
        {repos.length > 6 ? (
          <div className="relative mb-1.5">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-mute"
              aria-hidden
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="filter repositories…"
              aria-label="Filter repositories"
              className="py-1.5 pl-8 text-xs sm:py-1.5 sm:pl-8"
            />
          </div>
        ) : null}
        <div className="max-h-64 overflow-y-auto" role="listbox" aria-label="Repository filter">
          <button
            type="button"
            role="option"
            aria-selected={!active}
            onClick={() => pick(null)}
            className={optionClasses(!active)}
          >
            <span className="flex size-4 shrink-0 items-center justify-center">
              {!active ? <Check className="size-3.5" aria-hidden /> : null}
            </span>
            all repositories
          </button>
          {filtered.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs text-mute">no repositories match</p>
          ) : (
            filtered.map((r) => {
              const selected = r.id === value;
              return (
                <button
                  key={r.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => pick(selected ? null : r.id)}
                  className={optionClasses(selected)}
                >
                  <span className="flex size-4 shrink-0 items-center justify-center">
                    {selected ? <Check className="size-3.5" aria-hidden /> : null}
                  </span>
                  <FolderGit2 className="size-3.5 shrink-0 text-mute" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">
                    <span className="text-mute">{r.owner}/</span>
                    {r.name}
                  </span>
                  <span className="shrink-0 text-[11px] text-mute/70">{r.count}</span>
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function BoardPage() {
  const { data } = useSuspenseQuery(boardQuery);
  const [filter, setFilter] = useState<ColumnKey | 'all'>('all');
  const [repoId, setRepoId] = useState<number | null>(null);

  // Distinct repos across every card, with how many cards each matches.
  const filterRepos = useMemo(() => {
    const seen = new Map<number, FilterRepo>();
    const bump = (id: number, owner: string, name: string) => {
      const cur = seen.get(id) ?? { id, owner, name, count: 0 };
      cur.count += 1;
      seen.set(id, cur);
    };
    for (const t of data.todos) for (const r of t.repos) bump(r.id, r.owner, r.name);
    for (const t of data.tasks) for (const r of t.repos) bump(r.repository_id, r.owner, r.name);
    return [...seen.values()].sort((a, b) =>
      `${a.owner}/${a.name}`.localeCompare(`${b.owner}/${b.name}`),
    );
  }, [data]);
  // A refetch can drop the selected repo's last card — fall back to "all"
  // rather than filtering everything down to three empty columns.
  const repoFilter = filterRepos.some((r) => r.id === repoId) ? repoId : null;

  const todos =
    repoFilter === null
      ? data.todos
      : data.todos.filter((t) => t.repos.some((r) => r.id === repoFilter));
  const tasks =
    repoFilter === null
      ? data.tasks
      : data.tasks.filter((t) => t.repos.some((r) => r.repository_id === repoFilter));
  const inProgress = tasks.filter((t) => taskColumn(t) === 'in_progress');
  const done = tasks.filter((t) => taskColumn(t) === 'done');

  const show = (key: ColumnKey) => filter === 'all' || filter === key;
  // Generic empty copy misleads while a repo filter is active — the backlog
  // isn't empty, it's filtered.
  const filteredEmpty = 'nothing for this repository';

  const columns: { key: ColumnKey; el: ReactNode }[] = [
    {
      key: 'todo',
      el: (
        <Column
          key="todo"
          title="to do"
          count={todos.length}
          empty={repoFilter !== null ? filteredEmpty : 'backlog is empty — add todos above'}
        >
          {todos.map((t) => (
            <TodoCard key={t.id} todo={t} board={data} />
          ))}
        </Column>
      ),
    },
    {
      key: 'in_progress',
      el: (
        <Column
          key="in_progress"
          title="in progress"
          count={inProgress.length}
          empty={repoFilter !== null ? filteredEmpty : 'start a todo to put the agents to work'}
        >
          {inProgress.map((t) => (
            <TaskCard key={t.id} task={t} />
          ))}
        </Column>
      ),
    },
    {
      key: 'done',
      el: (
        <Column
          key="done"
          title="done"
          count={done.length}
          empty={repoFilter !== null ? filteredEmpty : 'merged tasks land here'}
        >
          {done.map((t) => (
            <TaskCard key={t.id} task={t} />
          ))}
        </Column>
      ),
    },
  ];

  return (
    <>
      <PageTitle
        aside={
          <Muted>
            {fmtUsd(data.stats.month_cost_usd)} this month
            {data.stats.running > 0 ? (
              <span className="text-accent-bright"> · {data.stats.running} running</span>
            ) : null}
          </Muted>
        }
      >
        board
      </PageTitle>

      <div className="mt-5 flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1 lg:max-w-xl">
          <QuickAdd board={data} />
        </div>
        {filterRepos.length > 1 ? (
          <RepoFilter repos={filterRepos} value={repoFilter} onChange={setRepoId} />
        ) : null}
      </div>

      {/* Mobile: filter chips instead of three side-by-side columns. */}
      <div
        className="mt-5 flex gap-2 overflow-x-auto pb-1 lg:hidden"
        role="tablist"
        aria-label="Filter by status"
      >
        {(
          [
            ['all', 'all'],
            ['todo', 'to do'],
            ['in_progress', 'in progress'],
            ['done', 'done'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={filter === key}
            onClick={() => setFilter(key)}
            className={cn(
              'cursor-pointer rounded-full px-3.5 py-1.5 text-xs whitespace-nowrap transition-colors',
              filter === key
                ? 'bg-accent/15 font-medium text-accent-bright'
                : 'bg-raised/60 text-mute hover:text-ink',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="mt-6 hidden gap-6 lg:grid lg:grid-cols-3">{columns.map((col) => col.el)}</div>
      <div className="mt-4 flex flex-col gap-7 lg:hidden">
        {columns.filter((col) => show(col.key)).map((col) => col.el)}
      </div>
    </>
  );
}
