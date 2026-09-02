import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  Archive,
  Check,
  ChevronDown,
  Filter,
  FolderGit2,
  Paperclip,
  Play,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import { toast } from 'sonner';
import type { ApiBoard, ApiPlan, ApiTodo } from '../../shared/api-types.ts';
import { isJsonObject, isString } from '../../shared/json.ts';
import { DEFAULT_RUNNER_MODEL, RUNNER_MODELS } from '../../shared/runner-models.ts';
import { api, ApiError } from '../lib/api.ts';
import { useDictation } from '../lib/dictation.ts';
import { ago, fmtUsd } from '../lib/format.ts';
import { applyOptimistic, optimisticId, optimisticNow } from '../lib/optimistic.ts';
import { boardQuery } from '../lib/queries.ts';
import { nextIndex, noOverlayOpen, onListboxKeyDown } from '../lib/shortcuts.ts';
import { taskColumn, taskStages, taskState } from '../lib/task-state.ts';
import { useIsDesktop } from '../lib/use-is-desktop.ts';
import { cn } from '../lib/utils.ts';
import { ConfirmButton } from '../components/confirm-button.tsx';
import {
  Placard,
  Serial,
  StageLights,
  Stamp,
  TelemetryStrip,
  type LampTone,
} from '../components/identity.tsx';
import { MicButton } from '../components/mic-button.tsx';
import { Muted, PageTitle } from '../components/section.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card } from '../components/ui/card.tsx';
import { Dialog, DialogContent, DialogTitle } from '../components/ui/dialog.tsx';
import { Field, Input, Select, Textarea } from '../components/ui/input.tsx';
import { Kbd } from '../components/ui/kbd.tsx';
import { Pill } from '../components/ui/pill.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover.tsx';

// The home board: To Do (unstarted todos, deletable) → In Progress (started
// tasks — planning through open PR) → Done (merged). Started tasks are only
// ever archived, never deleted.

type ColumnKey = 'todo' | 'in_progress' | 'done';

function onApiError<T>(err: T) {
  toast.error(err instanceof ApiError ? err.message : 'Request failed');
}

// The optional repo target for a *new* todo — the create-side mirror of the
// card's RepoPickerPopover, but over local state (no todo id yet). Repo stays
// optional (you can pick it later, before Start), so "Any repo" is a valid,
// first-class choice. When multiple installations exist and no repo is picked
// yet, a small installation selector decides where an "Any repo" todo lands.
function TargetPicker({
  board,
  installationId,
  onInstallationChange,
  selected,
  onChange,
}: {
  board: ApiBoard;
  installationId: number;
  onInstallationChange: (id: number) => void;
  selected: number[];
  onChange: (ids: number[]) => void;
}) {
  const [query, setQuery] = useState('');
  const multiInstall = board.installations.length > 1;
  const available = board.repos.filter((r) => r.installation_id === installationId);
  const filtered = query.trim()
    ? available.filter((r) => `${r.owner}/${r.name}`.toLowerCase().includes(query.toLowerCase()))
    : available;
  const toggle = (id: number) => {
    const isSel = selected.includes(id);
    const next = isSel ? selected.filter((i) => i !== id) : [...selected, id];
    if (next.length > 3) return;
    onChange(next);
  };
  const first = board.repos.find((r) => r.id === selected[0]);
  const label =
    selected.length === 0
      ? multiInstall
        ? `${board.installations.find((i) => i.id === installationId)?.account_login ?? 'Any'} · any repo`
        : 'Any repo'
      : selected.length === 1
        ? (first?.name ?? '1 repo')
        : `${first?.name} +${selected.length - 1}`;
  const optionClasses = (on: boolean) =>
    cn(
      'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 max-sm:py-2.5',
      on ? 'text-accent-bright' : 'text-ink-dim hover:bg-raised/70',
    );
  return (
    <Popover onOpenChange={(open) => !open && setQuery('')}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Repository target for the new todo"
          className={cn(
            'inline-flex cursor-pointer items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-xs whitespace-nowrap transition-colors sm:rounded-md sm:py-1.5',
            selected.length
              ? 'border-accent/40 text-accent-bright'
              : 'border-line-2/70 text-mute hover:border-line-2 hover:text-ink',
          )}
        >
          <FolderGit2 className="size-3.5 shrink-0" aria-hidden />
          <span className="max-w-44 truncate">{label}</span>
          <ChevronDown className="size-3.5 shrink-0 opacity-60" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" onKeyDown={onListboxKeyDown}>
        {multiInstall && selected.length === 0 ? (
          <div className="mb-1.5">
            <Select
              value={installationId}
              onChange={(e) => onInstallationChange(Number(e.target.value))}
              aria-label="Installation"
              className="text-xs sm:py-1.5"
            >
              {board.installations.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.account_login}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        {available.length > 6 ? (
          <div className="relative mb-1.5">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-mute"
              aria-hidden
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter repositories…"
              aria-label="Filter repositories"
              className="py-1.5 pl-8 text-xs sm:py-1.5 sm:pl-8"
            />
          </div>
        ) : null}
        <div className="max-h-64 overflow-y-auto" role="listbox" aria-label="Repositories">
          <button
            type="button"
            role="option"
            aria-selected={selected.length === 0}
            onClick={() => onChange([])}
            className={optionClasses(selected.length === 0)}
          >
            <span className="flex size-4 shrink-0 items-center justify-center">
              {selected.length === 0 ? <Check className="size-3.5" aria-hidden /> : null}
            </span>
            Any repo <span className="text-mute/70">— pick before Start</span>
          </button>
          {filtered.map((r) => {
            const isSel = selected.includes(r.id);
            const disabled = !isSel && selected.length >= 3;
            return (
              <button
                key={r.id}
                type="button"
                role="option"
                aria-selected={isSel}
                disabled={disabled}
                onClick={() => toggle(r.id)}
                className={optionClasses(isSel)}
              >
                <span className="flex size-4 shrink-0 items-center justify-center">
                  {isSel ? <Check className="size-3.5" aria-hidden /> : null}
                </span>
                <FolderGit2 className="size-3.5 shrink-0 text-mute" aria-hidden />
                <span className="min-w-0 truncate">
                  <span className="text-mute">{r.owner}/</span>
                  {r.name}
                </span>
              </button>
            );
          })}
          {filtered.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs text-mute">No repositories match.</p>
          ) : null}
        </div>
        <p className="mt-1.5 border-t border-line px-2 pt-1.5 text-[11px] text-mute/70">
          {selected.length}/3 · optional — a task targets up to 3 repos.
        </p>
      </PopoverContent>
    </Popover>
  );
}

function QuickAdd({
  board,
  activeRepoId,
  onShowAll,
}: {
  board: ApiBoard;
  activeRepoId: number | null;
  onShowAll: () => void;
}) {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState('');
  const [targetRepoIds, setTargetRepoIds] = useState<number[]>(activeRepoId ? [activeRepoId] : []);
  // The target defaults to whatever repo you're filtered to — so filter → add
  // keeps the new card in view — but stays a visible, editable choice. Once
  // the user edits it, we stop mirroring the filter (touched). Render-time
  // sync, the codebase's no-effect pattern.
  const [touched, setTouched] = useState(false);
  const [manualInstall, setManualInstall] = useState<number | null>(null);
  const [prevActive, setPrevActive] = useState(activeRepoId);
  if (activeRepoId !== prevActive) {
    setPrevActive(activeRepoId);
    if (!touched) setTargetRepoIds(activeRepoId ? [activeRepoId] : []);
  }
  const repoInstall = (id: number) => board.repos.find((r) => r.id === id)?.installation_id;
  // A todo's repos must share one installation; derive it from the target,
  // falling back to a manual pick, the active filter, then the first install.
  const installationId =
    (targetRepoIds.length ? repoInstall(targetRepoIds[0]) : undefined) ??
    manualInstall ??
    (activeRepoId ? repoInstall(activeRepoId) : undefined) ??
    board.installations[0]?.id ??
    0;

  // Power-user affordance: "/" focuses the quick-add from anywhere on the
  // board (form-tag suppression is the library default). Desktop-gated like
  // every other board hotkey.
  const isDesktop = useIsDesktop();
  useHotkeys(
    '/',
    () => inputRef.current?.focus(),
    { useKey: true, preventDefault: true, enabled: () => isDesktop && noOverlayOpen() },
    [isDesktop],
  );
  const add = useMutation({
    mutationFn: (vars: { title: string; installationId: number; repoIds: number[] }) =>
      api.post<
        { ok: boolean; todo_id: number },
        { installation_id: number; title: string; repository_ids: number[] }
      >('/api/todos', {
        installation_id: vars.installationId,
        title: vars.title,
        repository_ids: vars.repoIds,
      }),
    // The card appears (and the input clears, in submit) the moment Enter is
    // pressed — with its target repos already attached so it matches the
    // filter; the refetch below swaps in the server row.
    onMutate: async (vars) => {
      const tempId = optimisticId();
      const optimistic = await applyOptimistic<ApiBoard>(queryClient, ['board'], (prev) => ({
        ...prev,
        todos: [
          {
            id: tempId,
            installation_id: vars.installationId,
            title: vars.title,
            notes: null,
            created_at: optimisticNow(),
            repos: prev.repos
              .filter((r) => vars.repoIds.includes(r.id))
              .map((r) => ({ id: r.id, owner: r.owner, name: r.name })),
          },
          ...prev.todos,
        ],
      }));
      return { ...optimistic, tempId };
    },
    // Rewrite the temp id to the server id in place, so the card's key is
    // already stable when the onSettled refetch lands (a key change would
    // remount TodoCard and replay its mount animation).
    onSuccess: (res, _vars, ctx) => {
      queryClient.setQueryData<ApiBoard>(['board'], (prev) =>
        prev
          ? {
              ...prev,
              todos: prev.todos.map((t) => (t.id === ctx.tempId ? { ...t, id: res.todo_id } : t)),
            }
          : prev,
      );
    },
    onError: (err, _vars, ctx) => {
      ctx?.rollback();
      onApiError(err);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['board'] }),
  });
  const setTarget = (ids: number[]) => {
    setTouched(true);
    setTargetRepoIds(ids);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = title.trim();
    if (!t) return;
    const repoIds = targetRepoIds;
    add.mutate({ title: t, installationId, repoIds });
    // Transparent hand-off: if a repo filter is active and the new card won't
    // match it, say so (and offer to clear it) — never let a card silently
    // vanish, and never wipe the filter without asking.
    if (activeRepoId !== null && !repoIds.includes(activeRepoId)) {
      const name = board.repos.find((r) => r.id === activeRepoId)?.name ?? 'this repo';
      toast(`Added to backlog — hidden by the ${name} filter`, {
        action: { label: 'Show all', onClick: onShowAll },
      });
    }
    setTitle('');
    setTouched(false);
    setManualInstall(null);
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row sm:items-center">
      {/* A composed create field (not the bare Input) so the leading + and the
          "/" keycap sit inline without padding hacks — and it reads as create,
          not search. */}
      <div className="relative flex flex-1 items-center rounded-lg border border-line-2/70 bg-surface transition-colors focus-within:border-accent/50 sm:rounded-md">
        <Plus className="ml-3 size-4 shrink-0 text-accent" aria-hidden />
        <input
          ref={inputRef}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Add a todo…"
          aria-label="New todo title"
          maxLength={200}
          className="w-full bg-transparent px-2.5 py-2 text-base text-ink outline-none placeholder:text-mute/70 sm:py-1.5 sm:text-sm"
        />
        {!title ? (
          <Kbd className="pointer-events-none mr-2.5 hidden shrink-0 md:inline-flex">/</Kbd>
        ) : null}
      </div>
      <TargetPicker
        board={board}
        installationId={installationId}
        onInstallationChange={(id) => {
          setManualInstall(id);
          setTarget([]);
        }}
        selected={targetRepoIds}
        onChange={setTarget}
      />
      <Button type="submit">
        <Plus className="size-4" aria-hidden />
        Add
      </Button>
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
  const dictation = useDictation((text) =>
    setRequirements((prev) => (prev.trim() ? `${prev}\n\n${text}` : text)),
  );
  const [model, setModel] = useState<string>(DEFAULT_RUNNER_MODEL);
  const [files, setFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const start = useMutation({
    // Attachments (pdf/images) upload first — in parallel — then ride the
    // start payload so the planning agent reads them alongside the
    // requirements.
    mutationFn: async () => {
      const attachments = await Promise.all(
        files.map(async (file) => {
          const fd = new FormData();
          fd.append('file', file);
          const res = await fetch('/api/uploads', { method: 'POST', body: fd });
          const body = await res.json().catch(() => null);
          const data = isJsonObject(body) ? body : null;
          const key = data && isString(data.key) ? data.key : null;
          if (!res.ok || !key) {
            const message = data && isString(data.error) ? data.error : null;
            throw new ApiError(message ?? `upload failed for ${file.name}`, res.status);
          }
          return {
            key,
            name: data && isString(data.name) ? data.name : file.name,
            content_type: data && isString(data.content_type) ? data.content_type : file.type,
          };
        }),
      );
      return api.post(`/api/todos/${todo.id}/start`, { title, requirements, attachments, model });
    },
    // With nothing to upload the dialog closes on click — the request is a
    // single POST and the board reconciles in the background. With files the
    // dialog stays up (spinner on the submit) so an upload failure can't
    // strand the user's attachments in an unmounted form.
    onMutate: () => {
      if (files.length === 0) onClose();
    },
    onSuccess: () => {
      toast.success('Task started — the planning agent is on it');
      void queryClient.invalidateQueries({ queryKey: ['board'] });
      if (files.length > 0) onClose();
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
          <Field label="Repositories">
            <RepoChips todo={todo} board={board} />
          </Field>
          <Field label="Title">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              maxLength={200}
            />
          </Field>
          <Field label="Requirements">
            <Textarea
              value={
                dictation.recording
                  ? requirements.trim()
                    ? `${requirements}\n\n${dictation.interim}`
                    : dictation.interim
                  : requirements
              }
              onChange={(e) => setRequirements(e.target.value)}
              disabled={dictation.recording}
              required
              className="min-h-28"
              placeholder="What should be built? The planning agent reads the repo and drafts a plan you approve."
            />
          </Field>
          <Field label="Model">
            <Select value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model">
              {RUNNER_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </Select>
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
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
              >
                <Paperclip className="size-3.5" aria-hidden /> Attach files (PDF, images)
              </Button>
              <MicButton dictation={dictation} />
            </div>
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
                      className="cursor-pointer rounded-full p-0.5 text-mute hover:text-danger max-sm:p-2"
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
              title={todo.repos.length === 0 ? 'Select at least one repository first' : undefined}
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
    onMutate: async (ids) => {
      await queryClient.cancelQueries({ queryKey: ['board'] });
      const prev = queryClient.getQueryData<ApiBoard>(['board']);
      if (prev) {
        queryClient.setQueryData<ApiBoard>(['board'], {
          ...prev,
          todos: prev.todos.map((t) =>
            t.id === todo.id
              ? {
                  ...t,
                  repos: prev.repos
                    .filter((r) => ids.includes(r.id))
                    .map((r) => ({ id: r.id, owner: r.owner, name: r.name })),
                }
              : t,
          ),
        });
      }
      return { prev };
    },
    onError: (err, _ids, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(['board'], ctx.prev);
      onApiError(err);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['board'] }),
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
            'inline-flex cursor-pointer items-center gap-1 rounded-full border border-dashed border-line-2 px-2 py-0.5 text-xs text-mute transition-colors hover:border-accent/40 hover:text-accent-bright max-sm:px-3 max-sm:py-1.5',
          )}
        >
          <Plus className="size-3" aria-hidden />
          {todo.repos.length === 0 ? 'Repos' : 'Edit'}
        </button>
      </PopoverTrigger>
      <PopoverContent onKeyDown={onListboxKeyDown}>
        {available.length > 6 ? (
          <div className="relative mb-1.5">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-mute"
              aria-hidden
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter repositories…"
              aria-label="Filter repositories"
              className="py-1.5 pl-8 text-xs sm:py-1.5 sm:pl-8"
            />
          </div>
        ) : null}
        <div className="max-h-64 overflow-y-auto" role="listbox" aria-label="Repositories">
          {filtered.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs text-mute">No repositories match.</p>
          ) : (
            filtered.map((r) => {
              const selected = selectedIds.includes(r.id);
              const disabled = !selected && selectedIds.length >= 3;
              return (
                <button
                  key={r.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  disabled={disabled}
                  onClick={() => toggle(r.id)}
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 max-sm:py-2.5',
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
          {selectedIds.length}/3 selected — a task targets up to 3 repos.
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
    // The card leaves the board on confirm, not after the round-trip.
    onMutate: () =>
      applyOptimistic<ApiBoard>(queryClient, ['board'], (prev) => ({
        ...prev,
        todos: prev.todos.filter((t) => t.id !== todo.id),
      })),
    onError: (err, _v, ctx) => {
      ctx?.rollback();
      onApiError(err);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['board'] }),
  });
  return (
    <Card
      className="animate-rise p-3"
      // Tab-reachable so the card keys (Enter/s/d) work without j/k.
      tabIndex={0}
      data-board-card
      data-column="todo"
      aria-label={todo.title}
      onKeyDown={(e) => {
        // Only when the card itself is focused — keys on inner buttons/links
        // must not double-fire.
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === 's') {
          e.preventDefault();
          setStarting(true);
        } else if (e.key === 'd') {
          e.preventDefault();
          e.currentTarget.querySelector<HTMLButtonElement>('[data-card-action="delete"]')?.click();
        }
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-[0.85rem] font-medium break-words">{todo.title}</span>
        <ConfirmButton
          variant="ghost"
          size="icon"
          className="size-6 shrink-0 text-mute hover:text-danger"
          data-card-action="delete"
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
  const navigate = useNavigate();
  const state = taskState(task);
  const column = taskColumn(task);
  const done = column === 'done';
  const archive = useMutation({
    mutationFn: () => api.post(`/api/tasks/${task.id}/archive`, { archived: true }),
    // The card leaves the board on confirm, not after the round-trip.
    onMutate: () =>
      applyOptimistic<ApiBoard>(queryClient, ['board'], (prev) => ({
        ...prev,
        tasks: prev.tasks.filter((t) => t.id !== task.id),
      })),
    onSuccess: () => toast.success('Task archived'),
    onError: (err, _v, ctx) => {
      ctx?.rollback();
      onApiError(err);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['board'] }),
  });
  // The card an agent is on right now gets the yellow edge and shadow — the
  // one place per column the working colour is allowed to be loud.
  const live = state.tone === 'running';
  return (
    <Card
      className={cn(
        'animate-rise p-3 transition-[border-color,box-shadow] hover:border-accent/50',
        live && 'border-accent shadow-sticker-live',
      )}
      // Tab-reachable so the card keys (Enter/e) work without j/k.
      tabIndex={0}
      data-board-card
      data-column={column}
      aria-label={task.title}
      onKeyDown={(e) => {
        // Only when the card itself is focused — keys on inner buttons/links
        // must not double-fire.
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          void navigate({ to: '/tasks/$taskId', params: { taskId: String(task.id) } });
        } else if (e.key === 'e') {
          e.preventDefault();
          e.currentTarget.querySelector<HTMLButtonElement>('[data-card-action="archive"]')?.click();
        }
      }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <Serial n={task.id} />
        <span className="flex items-center gap-2">
          {done ? <Stamp tone="ok">MERGED</Stamp> : null}
          <ConfirmButton
            variant="ghost"
            size="icon"
            className="size-6 shrink-0 text-mute"
            data-card-action="archive"
            title="Archive this task?"
            description="Started tasks are never deleted — archiving hides it from the board. The plan, PR, and history stay."
            confirmLabel="Archive"
            onConfirm={() => archive.mutate()}
            busy={archive.isPending}
            aria-label={`Archive task ${task.title}`}
          >
            <Archive className="size-3.5" aria-hidden />
          </ConfirmButton>
        </span>
      </div>
      <Link
        to="/tasks/$taskId"
        params={{ taskId: String(task.id) }}
        className="mt-2 block min-w-0 text-[0.85rem] font-medium break-words hover:text-accent"
      >
        {task.title}
      </Link>
      {done ? null : (
        <>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            <Pill tone={state.tone} className="max-w-full">
              <span className="min-w-0 truncate">{state.label}</span>
            </Pill>
            {task.repos
              .filter((r) => r.verification && r.feature_status !== 'merged')
              .map((r) => {
                // Full label truncates with an ellipsis (title carries the rest)
                // so a long repo path can never run off the card edge.
                const label = `${r.owner}/${r.name} Verify: ${r.verification!.status}`;
                return (
                  <Pill
                    key={r.repository_id}
                    title={label}
                    className="max-w-full"
                    tone={
                      r.verification!.status === 'passed'
                        ? 'on'
                        : r.verification!.status === 'running'
                          ? 'running'
                          : 'red'
                    }
                  >
                    <span className="min-w-0 truncate">{label}</span>
                  </Pill>
                );
              })}
          </div>
          <StageLights stages={taskStages(task)} className="mt-2" />
        </>
      )}
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
  lamp,
  pulse,
  count,
  children,
  empty,
}: {
  title: string;
  lamp: LampTone;
  pulse?: boolean;
  count: number;
  children: ReactNode;
  empty: string;
}) {
  return (
    <section className="min-w-0">
      <h2 className="mb-2.5">
        <Placard lamp={lamp} pulse={pulse} aside={count}>
          {title}
        </Placard>
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

// Whole-board repo filter as a pill row: every repo on the cards is one
// toggle, with its match count inline, so the filter reads as a filter (not a
// search) and the whole set is visible at a glance. Options come from the
// repos actually on the cards, so every pill matches at least one card.
const FILTER_PILL_CAP = 8;

function filterPill(active: boolean) {
  return cn(
    'inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 font-mono text-xs whitespace-nowrap transition-colors',
    active
      ? 'border-accent/40 bg-accent/10 text-accent-bright'
      : 'border-line-2/70 text-mute hover:border-line-2 hover:text-ink',
  );
}

function RepoFilterPills({
  repos,
  value,
  onChange,
  allCount,
}: {
  repos: FilterRepo[];
  value: number | null;
  onChange: (id: number | null) => void;
  allCount: number;
}) {
  // Show a capped row of pills; the rest fold into a searchable "More". The
  // active repo is always pulled into the visible set so a filtered board
  // never hides which pill is lit.
  const head = repos.slice(0, FILTER_PILL_CAP);
  const activeHidden = value !== null && !head.some((r) => r.id === value);
  const visible = activeHidden
    ? [
        repos.find((r) => r.id === value)!,
        ...repos.filter((r) => r.id !== value).slice(0, FILTER_PILL_CAP - 1),
      ]
    : head;
  const hidden = repos.filter((r) => !visible.some((v) => v.id === r.id));
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10px] tracking-[0.14em] text-mute uppercase">
        <Filter className="size-3" aria-hidden />
        Filter
      </span>
      <div className="flex min-w-0 items-center gap-2 overflow-x-auto pb-1">
        <button
          type="button"
          onClick={() => onChange(null)}
          aria-pressed={value === null}
          className={filterPill(value === null)}
        >
          All <span className="text-[10px] opacity-70">{allCount}</span>
        </button>
        {visible.map((r) => {
          const active = r.id === value;
          return (
            <button
              key={r.id}
              type="button"
              onClick={() => onChange(active ? null : r.id)}
              aria-pressed={active}
              title={`${r.owner}/${r.name}`}
              className={filterPill(active)}
            >
              {r.name} <span className="text-[10px] opacity-70">{r.count}</span>
            </button>
          );
        })}
        {hidden.length > 0 ? (
          <RepoFilterMore repos={hidden} value={value} onChange={onChange} />
        ) : null}
      </div>
    </div>
  );
}

// Overflow for the pill row: the repos that didn't fit, in the same searchable
// list the picker uses elsewhere. Single-select, mirroring the pills.
function RepoFilterMore({
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
  const pick = (id: number | null) => {
    onChange(id);
    setOpen(false);
  };
  const activeHere = repos.some((r) => r.id === value);
  return (
    <Popover
      open={open}
      onOpenChange={(o: boolean) => {
        setOpen(o);
        if (!o) setQuery('');
      }}
    >
      <PopoverTrigger asChild>
        <button type="button" aria-label="More repositories" className={filterPill(activeHere)}>
          More <ChevronDown className="size-3 shrink-0 opacity-60" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" onKeyDown={onListboxKeyDown}>
        {repos.length > 6 ? (
          <div className="relative mb-1.5">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-mute"
              aria-hidden
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter repositories…"
              aria-label="Filter repositories"
              className="py-1.5 pl-8 text-xs sm:py-1.5 sm:pl-8"
            />
          </div>
        ) : null}
        <div className="max-h-64 overflow-y-auto" role="listbox" aria-label="Repository filter">
          {filtered.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs text-mute">No repositories match.</p>
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
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors max-sm:py-2.5',
                    selected ? 'text-accent-bright' : 'text-ink-dim hover:bg-raised/70',
                  )}
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

// Roving j/k/h/l focus across the board cards, driven by the DOM rather than
// React state. The lanes render twice (desktop grid + mobile list); filtering
// on offsetParent keeps focus inside whichever tree is actually visible.
function moveBoardFocus(key: string) {
  const cards = [...document.querySelectorAll<HTMLElement>('[data-board-card]')].filter(
    (el) => el.offsetParent !== null,
  );
  if (cards.length === 0) return;
  // Group into non-empty columns, preserving DOM order.
  const byColumn = new Map<string, HTMLElement[]>();
  for (const el of cards) {
    const col = el.dataset.column ?? '';
    let list = byColumn.get(col);
    if (!list) byColumn.set(col, (list = []));
    list.push(el);
  }
  const columns = [...byColumn.values()];
  const current = document.activeElement?.closest<HTMLElement>('[data-board-card]');
  let target: HTMLElement | undefined;
  if (!current || !cards.includes(current)) {
    target = cards[0];
  } else {
    const colIndex = columns.findIndex((list) => list.includes(current));
    const column = columns[colIndex]!;
    const row = column.indexOf(current);
    if (key === 'j' || key === 'arrowdown') target = column[nextIndex(row, column.length, 1)];
    else if (key === 'k' || key === 'arrowup') target = column[nextIndex(row, column.length, -1)];
    else {
      const dir = key === 'l' || key === 'arrowright' ? 1 : -1;
      const next = columns[colIndex + dir];
      if (!next) return;
      target = next[Math.min(row, next.length - 1)];
    }
  }
  if (!target) return;
  target.focus();
  target.scrollIntoView({ block: 'nearest' });
}

export function BoardPage() {
  const { data } = useSuspenseQuery(boardQuery);
  const isDesktop = useIsDesktop();
  useHotkeys(
    'j,k,down,up,h,l,left,right',
    (e, hk) => {
      moveBoardFocus(hk.keys?.join('') ?? '');
      e.preventDefault();
    },
    { enabled: () => isDesktop && noOverlayOpen() },
    [isDesktop],
  );
  const [filter, setFilter] = useState<ColumnKey | 'all'>('all');
  const [repoId, setRepoId] = useState<number | null>(null);

  // Every factory-enabled repo plus any repo referenced by a card (covers
  // repos disabled after their cards were made), with how many cards each
  // matches. Seeding from data.repos — not just the cards — keeps the filter
  // visible whenever the user actually has multiple repos, even if only one
  // has cards right now; picking a quiet repo shows the honest empty state.
  const filterRepos = useMemo(() => {
    const seen = new Map<number, FilterRepo>();
    for (const r of data.repos)
      seen.set(r.id, { id: r.id, owner: r.owner, name: r.name, count: 0 });
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
  const filteredEmpty = 'Nothing for this repository.';

  const columns: { key: ColumnKey; el: ReactNode }[] = [
    {
      key: 'todo',
      el: (
        <Column
          key="todo"
          title="To do"
          lamp="off"
          count={todos.length}
          empty={repoFilter !== null ? filteredEmpty : 'The backlog is empty — add todos above.'}
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
          title="In progress"
          lamp={inProgress.length > 0 ? 'hold' : 'off'}
          pulse={data.stats.running > 0}
          count={inProgress.length}
          empty={repoFilter !== null ? filteredEmpty : 'Start a todo to put the agents to work.'}
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
          title="Done"
          lamp={done.length > 0 ? 'go' : 'off'}
          count={done.length}
          empty={repoFilter !== null ? filteredEmpty : 'Merged tasks land here.'}
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
      <PageTitle>Board</PageTitle>
      <TelemetryStrip
        className="mt-3"
        running={data.stats.running}
        items={[
          { label: 'Active runs', value: data.stats.running },
          { label: 'Pipeline (month)', value: fmtUsd(data.stats.month_pipeline_cost_usd) },
        ]}
      />

      <div className="mt-5 space-y-3">
        <QuickAdd board={data} activeRepoId={repoFilter} onShowAll={() => setRepoId(null)} />
        {filterRepos.length > 1 ? (
          <div className="border-t border-line/70 pt-3">
            <RepoFilterPills
              repos={filterRepos}
              value={repoFilter}
              onChange={setRepoId}
              allCount={data.todos.length + data.tasks.length}
            />
          </div>
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
            ['all', 'All'],
            ['todo', 'To do'],
            ['in_progress', 'In progress'],
            ['done', 'Done'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={filter === key}
            onClick={() => setFilter(key)}
            className={cn(
              'cursor-pointer rounded-full px-4 py-2 text-xs whitespace-nowrap transition-colors',
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
