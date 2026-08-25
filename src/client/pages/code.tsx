import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { useBlocker, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import {
  ArrowLeft,
  Check,
  ChevronDown,
  GitBranch,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { ApiFileSave, ApiRepoCode } from '../../shared/api-types.ts';
import { api, ApiError } from '../lib/api.ts';
import { repoCodeQuery, repoFileQuery } from '../lib/queries.ts';
import { cn } from '../lib/utils.ts';
import { CodeEditor } from '../components/code-editor.tsx';
import { RepoTree } from '../components/repo-tree.tsx';
import { EmptyState, Muted, PageTitle } from '../components/section.tsx';
import { Button, buttonVariants } from '../components/ui/button.tsx';
import { Card } from '../components/ui/card.tsx';
import { Dialog, DialogContent, DialogTitle } from '../components/ui/dialog.tsx';
import { Field, Input } from '../components/ui/input.tsx';
import { OptionCard } from '../components/ui/option-card.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover.tsx';

// The code browser: the whole repository readable (and editable) in the
// browser, straight off the GitHub REST API — no clone. The branch rides in
// ?ref= and the file path in the splat, so a deep link restores both.

const ROUTE_ID = '/shell/repos/$repoId/code/$';
const SAVE_MODE_KEY = 'turbodiff:code-save-mode';
type SaveMode = 'commit' | 'pr';

function onApiError<T>(err: T) {
  toast.error(err instanceof ApiError ? err.message : 'Request failed');
}

export default function CodePage() {
  const params = useParams({ from: ROUTE_ID });
  const repoId = Number(params.repoId);
  const filePath = params._splat ?? '';
  const search = useSearch({ from: ROUTE_ID });
  const { data } = useSuspenseQuery(repoCodeQuery(repoId));
  const refName = search.ref ?? data.default_branch ?? '';

  const title = (
    <span className="font-mono">
      <span className="text-mute">{data.repo.owner}/</span>
      {data.repo.name}
    </span>
  );

  if (!refName) {
    return (
      <div className="animate-rise">
        <PageTitle>{title}</PageTitle>
        <Card className="mt-6 max-w-xl">
          <Muted>This repository has no branches yet.</Muted>
        </Card>
      </div>
    );
  }

  return (
    <Browser
      key={`${repoId}:${refName}`}
      data={data}
      repoId={repoId}
      refName={refName}
      filePath={filePath}
      title={title}
    />
  );
}

function Browser({
  data,
  repoId,
  refName,
  filePath,
  title,
}: {
  data: ApiRepoCode;
  repoId: number;
  refName: string;
  filePath: string;
  title: React.ReactNode;
}) {
  const navigate = useNavigate();
  const goTo = (path: string, ref = refName) =>
    void navigate({
      to: '/repos/$repoId/code/$',
      params: { repoId: String(repoId), _splat: path },
      search: { ref },
    });

  // The desktop tree panel collapses to a thin rail; remembered across
  // visits since it's a workspace-layout preference (same as the cockpit).
  const [treeOpen, setTreeOpenState] = useState(
    () => localStorage.getItem('turbodiff.codeTree') !== 'closed',
  );
  const setTreeOpen = (open: boolean) => {
    setTreeOpenState(open);
    localStorage.setItem('turbodiff.codeTree', open ? 'open' : 'closed');
  };

  const segments = filePath ? filePath.split('/') : [];

  return (
    <div className="animate-rise">
      <PageTitle
        aside={
          <BranchPicker
            current={refName}
            branches={data.branches}
            onSelect={(branch) => goTo(filePath, branch)}
          />
        }
      >
        {title}
      </PageTitle>
      {segments.length > 0 ? (
        <p className="mt-2 flex flex-wrap items-center font-mono text-xs text-mute">
          {segments.map((segment, i) => (
            <span key={`${i}-${segment}`} className="flex items-center">
              {i > 0 ? <span className="px-0.5 text-mute/60">/</span> : null}
              <span className={i === segments.length - 1 ? 'text-ink' : undefined}>{segment}</span>
            </span>
          ))}
        </p>
      ) : null}

      <div
        className={cn(
          'mt-4 lg:grid lg:items-start lg:gap-6 lg:transition-[grid-template-columns] lg:duration-200',
          treeOpen ? 'lg:grid-cols-[16rem_minmax(0,1fr)]' : 'lg:grid-cols-[2.25rem_minmax(0,1fr)]',
        )}
      >
        {/* Mobile shows tree OR file (feature #44's no-zoom, plain-button
            investment); desktop keeps the cockpit's sticky collapsible rail. */}
        <aside
          className={cn(
            filePath && 'hidden',
            'lg:sticky lg:top-4 lg:flex lg:max-h-[calc(100dvh-2rem)] lg:flex-col',
          )}
        >
          {treeOpen ? (
            <div className="hidden items-center justify-between gap-2 px-1.5 pb-2 lg:flex">
              <span className="font-mono text-xs font-medium tracking-[0.14em] text-mute uppercase">
                Files
              </span>
              <button
                type="button"
                onClick={() => setTreeOpen(false)}
                title="Hide the file tree"
                aria-label="Hide the file tree"
                className="cursor-pointer rounded-md p-1 text-mute transition-colors hover:bg-raised/60 hover:text-ink"
              >
                <PanelLeftClose className="size-3.5" aria-hidden />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setTreeOpen(true)}
              title="Show the file tree"
              aria-label="Show the file tree"
              className="hidden cursor-pointer flex-col items-center gap-2 rounded-md border border-line bg-surface px-1.5 py-2 text-mute transition-colors hover:border-line-2 hover:text-ink lg:flex"
            >
              <PanelLeftOpen className="size-3.5" aria-hidden />
              <span className="font-mono text-[10px] [writing-mode:vertical-rl]">Files</span>
            </button>
          )}
          {/* The collapse-to-rail preference is desktop-only — the mobile
              tree (the whole screen when no file is open) always renders. */}
          <div
            className={cn('min-h-0 flex-1 lg:overflow-y-auto lg:pb-2', !treeOpen && 'lg:hidden')}
          >
            <RepoTree
              repoId={repoId}
              treeRef={refName}
              activePath={filePath || null}
              onSelectFile={(path) => goTo(path)}
            />
          </div>
        </aside>

        <div className={cn('min-w-0', !filePath && 'hidden lg:block')}>
          {filePath ? (
            <FilePane
              key={`${refName}:${filePath}`}
              repo={data.repo}
              repoId={repoId}
              refName={refName}
              path={filePath}
              onBack={() => goTo('')}
            />
          ) : (
            <EmptyState>Select a file from the tree to view it.</EmptyState>
          )}
        </div>
      </div>
    </div>
  );
}

function BranchPicker({
  current,
  branches,
  onSelect,
}: {
  current: string;
  branches: string[];
  onSelect: (branch: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const q = filter.trim().toLowerCase();
  const shown = q ? branches.filter((b) => b.toLowerCase().includes(q)) : branches;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setFilter('');
      }}
    >
      <PopoverTrigger
        className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }), 'max-w-60')}
        title="Switch branch"
      >
        <GitBranch className="size-3.5 shrink-0 text-mute" aria-hidden />
        <span className="truncate font-mono">{current}</span>
        <ChevronDown className="size-3 shrink-0 text-mute" aria-hidden />
      </PopoverTrigger>
      <PopoverContent className="w-64 p-1.5" align="end">
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter branches…"
          aria-label="Filter branches"
          className="mb-1.5 font-mono text-xs sm:text-xs"
        />
        <ul className="max-h-64 overflow-y-auto">
          {shown.map((branch) => (
            <li key={branch}>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setFilter('');
                  onSelect(branch);
                }}
                aria-current={branch === current ? 'true' : undefined}
                className={cn(
                  'flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-left font-mono text-xs transition-colors',
                  branch === current
                    ? 'bg-accent/10 text-accent-bright'
                    : 'text-ink-dim hover:bg-raised/60 hover:text-ink',
                )}
              >
                <span className="min-w-0 truncate">{branch}</span>
                {branch === current ? (
                  <Check className="ml-auto size-3.5 shrink-0" aria-hidden />
                ) : null}
              </button>
            </li>
          ))}
          {shown.length === 0 ? (
            <li className="px-2 py-1.5 text-xs text-mute">No branches match</li>
          ) : null}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function FilePane({
  repo,
  repoId,
  refName,
  path,
  onBack,
}: {
  repo: ApiRepoCode['repo'];
  repoId: number;
  refName: string;
  path: string;
  onBack: () => void;
}) {
  const queryClient = useQueryClient();
  const fileQuery = useQuery(repoFileQuery(repoId, refName, path));
  const file = fileQuery.data;

  const [editing, setEditing] = useState(false);
  const [buffer, setBuffer] = useState('');
  const [saveOpen, setSaveOpen] = useState(false);
  const [message, setMessage] = useState('');
  // The per-save choice (commit vs branch + PR) is remembered for the
  // session and shown on the Save control itself. PR saves are GitHub-only:
  // Artifacts repos always commit directly, even when sessionStorage holds a
  // 'pr' remembered from a GitHub repo.
  const canPr = repo.provider === 'github';
  const [modeState, setModeState] = useState<SaveMode>(() =>
    sessionStorage.getItem(SAVE_MODE_KEY) === 'pr' ? 'pr' : 'commit',
  );
  const mode = canPr ? modeState : 'commit';
  const setMode = (next: SaveMode) => {
    setModeState(next);
    sessionStorage.setItem(SAVE_MODE_KEY, next);
  };

  const loadedText = file?.text ?? '';
  const dirty = editing && buffer !== loadedText;

  // Tree clicks (and back/forward, and tab close) must not silently drop an
  // edit — the buffer only leaves memory on an explicit discard or save.
  useBlocker({
    shouldBlockFn: () => {
      if (!dirty) return false;
      return !window.confirm('You have an unsaved edit — discard it and leave?');
    },
    enableBeforeUnload: () => dirty,
  });

  const reloadFile = () =>
    void queryClient.invalidateQueries({ queryKey: ['repo-file', repoId, refName, path] });

  const save = useMutation({
    mutationFn: () =>
      api.put<
        ApiFileSave,
        {
          path: string;
          ref: string;
          base_sha: string | null;
          content: string;
          message: string;
          mode: SaveMode;
        }
      >(`/api/repos/${repoId}/file`, {
        path,
        ref: refName,
        base_sha: file?.sha ?? null,
        content: buffer,
        message,
        mode,
      }),
    onSuccess: (result) => {
      setSaveOpen(false);
      setEditing(false);
      if (result.pr) {
        // The PR carries the edit; this ref's content is unchanged.
        const pr = result.pr;
        toast.success(
          <span>
            <a
              href={pr.url}
              target="_blank"
              rel="noopener"
              className="text-accent-bright underline"
            >
              PR #{pr.number}
            </a>{' '}
            opened
          </span>,
        );
      } else {
        toast.success(`Committed to ${result.branch}`);
        reloadFile();
      }
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) {
        // Keep the buffer — the user reapplies their edit after reloading.
        toast.error('The file changed on the branch since you opened it.', {
          action: { label: 'Reload file', onClick: reloadFile },
        });
        return;
      }
      onApiError(err);
    },
  });

  const backButton = (
    <Button variant="ghost" size="sm" className="lg:hidden" onClick={onBack}>
      <ArrowLeft className="size-3.5" aria-hidden /> Files
    </Button>
  );

  if (fileQuery.isPending) {
    return (
      <div>
        {backButton}
        <div className="flex min-h-40 items-center justify-center text-mute" role="status">
          <span>
            Loading<span className="animate-cursor text-accent-bright">_</span>
          </span>
        </div>
      </div>
    );
  }
  if (fileQuery.isError || !file) {
    return (
      <div>
        {backButton}
        <Card className="mt-2">
          <p className="text-[0.85rem] text-danger">
            {fileQuery.error instanceof ApiError
              ? fileQuery.error.message
              : 'Could not load this file.'}
          </p>
        </Card>
      </div>
    );
  }
  if (file.too_large) {
    return (
      <div>
        {backButton}
        <Card className="mt-2">
          {repo.provider === 'github' ? (
            <Muted>
              File is larger than 1 MB —{' '}
              <a
                href={`https://github.com/${repo.owner}/${repo.name}/blob/${encodeURIComponent(refName)}/${path}`}
                target="_blank"
                rel="noopener"
                className="text-accent-bright hover:underline"
              >
                view it on GitHub &rarr;
              </a>
            </Muted>
          ) : (
            <Muted>
              File is larger than 1 MB — clone the repo to view it (Settings &rarr; Clone).
            </Muted>
          )}
        </Card>
      </div>
    );
  }
  if (file.binary || file.text === null) {
    return (
      <div>
        {backButton}
        <Card className="mt-2">
          <Muted>Binary file — {file.size} bytes</Muted>
        </Card>
      </div>
    );
  }

  const startEditing = () => {
    setBuffer(file.text ?? '');
    setEditing(true);
  };
  const discard = () => {
    setEditing(false);
    setBuffer('');
  };
  const openSave = () => {
    setMessage(`Update ${path}`);
    setSaveOpen(true);
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 pb-2">
        {backButton}
        <span className="ml-auto flex items-center gap-2">
          {editing ? (
            <>
              <Button variant="ghost" size="sm" onClick={discard}>
                Discard
              </Button>
              <Button size="sm" onClick={openSave} disabled={!dirty}>
                {mode === 'commit' ? `Save · commit to ${refName}` : 'Save · via PR'}
              </Button>
            </>
          ) : (
            <Button variant="secondary" size="sm" onClick={startEditing}>
              <Pencil className="size-3.5" aria-hidden /> Edit
            </Button>
          )}
        </span>
      </div>
      <div className="h-[70dvh] min-h-72 overflow-hidden rounded-lg border border-line bg-surface">
        <CodeEditor
          value={editing ? buffer : loadedText}
          onChange={setBuffer}
          path={path}
          readOnly={!editing}
        />
      </div>

      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent>
          <DialogTitle className="pr-8 text-[0.95rem] font-medium break-words">
            Save {path}
          </DialogTitle>
          <Field label="Commit message">
            <Input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              aria-label="Commit message"
              className="font-mono"
            />
          </Field>
          <div className="mt-4 flex flex-col gap-2">
            <OptionCard selected={mode === 'commit'} onClick={() => setMode('commit')}>
              Commit to <span className="font-mono text-accent-bright">{refName}</span>
            </OptionCard>
            {canPr ? (
              <OptionCard selected={mode === 'pr'} onClick={() => setMode('pr')}>
                New branch + pull request
              </OptionCard>
            ) : null}
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setSaveOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" loading={save.isPending} onClick={() => save.mutate()}>
              {mode === 'commit' ? `Commit to ${refName}` : 'Open pull request'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
