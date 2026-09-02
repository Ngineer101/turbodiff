import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { useBlocker, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Code,
  Eye,
  GitBranch,
  Pencil,
  WrapText,
} from 'lucide-react';
import { lazy, Suspense, useMemo, useRef, useState } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import { toast } from 'sonner';
import type { ApiFileSave, ApiRepoCode } from '../../shared/api-types.ts';
import { binaryPreviewKind, isSvgPath } from '../../shared/binary-preview.ts';
import { api, ApiError } from '../lib/api.ts';
import {
  DIFF_PREVIEW_MAX_LINES,
  diffLines,
  diffStats,
  toHunks,
  type DiffHunk,
} from '../lib/line-diff.ts';
import { repoCodeQuery, repoFileQuery } from '../lib/queries.ts';
import { useIsDesktop } from '../lib/use-is-desktop.ts';
import { cn } from '../lib/utils.ts';
import {
  FontPreview,
  ImagePreview,
  PdfPreview,
  SvgPreview,
} from '../components/binary-preview.tsx';
import { RepoTree } from '../components/repo-tree.tsx';
import { EmptyState, Muted, PageTitle } from '../components/section.tsx';
import { Button, buttonVariants } from '../components/ui/button.tsx';
import { Card } from '../components/ui/card.tsx';
import { Dialog, DialogContent, DialogTitle } from '../components/ui/dialog.tsx';
import { Field, Input } from '../components/ui/input.tsx';
import { Kbd } from '../components/ui/kbd.tsx';
import { OptionCard } from '../components/ui/option-card.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover.tsx';

const CodeEditor = lazy(() =>
  import('../components/code-editor.tsx').then((module) => ({ default: module.CodeEditor })),
);

// The code browser: the whole repository readable (and editable) in the
// browser, straight off the GitHub REST API — no clone. The branch rides in
// ?ref= and the file path in the splat, so a deep link restores both.

const ROUTE_ID = '/shell/repos/$repoId/code/$';
const SAVE_MODE_KEY = 'turbodiff:code-save-mode';
// Soft-wrap preference — workspace layout, like the tree rail.
const WRAP_KEY = 'turbodiff.codeWrap';
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
  const queryClient = useQueryClient();
  const goTo = (path: string, ref = refName) =>
    void navigate({
      to: '/repos/$repoId/code/$',
      params: { repoId: String(repoId), _splat: path },
      search: { ref },
    });

  // Focus hand-off is desktop-only: on mobile the tree is either the whole
  // screen (no file) or hidden entirely, and moving focus there is wrong
  // both ways.
  const isDesktop = useIsDesktop();

  const segments = filePath ? filePath.split('/') : [];

  return (
    <div className="animate-rise lg:flex lg:min-h-0 lg:flex-1 lg:flex-col">
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

      <div className="mt-4 lg:grid lg:min-h-0 lg:flex-1 lg:grid-cols-[16rem_minmax(0,1fr)] lg:gap-6">
        {/* A fixed, always-visible file tree — the point of focus for the code
            browser. Mobile shows tree OR file (feature #44's no-zoom, plain
            buttons); desktop keeps it pinned as the left rail. */}
        <aside className={cn(filePath && 'hidden', 'lg:flex lg:min-h-0 lg:flex-col')}>
          <p className="hidden px-1.5 pb-2 font-mono text-[10px] font-medium tracking-[0.16em] text-mute uppercase lg:block">
            Files
          </p>
          <div className="min-h-0 flex-1 lg:overflow-y-auto lg:pb-2">
            <RepoTree
              repoId={repoId}
              treeRef={refName}
              activePath={filePath || null}
              autoFocus={isDesktop}
              onSelectFile={(path) => goTo(path)}
              fileHref={(path) =>
                `/repos/${repoId}/code/${path}?ref=${encodeURIComponent(refName)}`
              }
              onPrefetchFile={(path) =>
                void queryClient.prefetchQuery(repoFileQuery(repoId, refName, path))
              }
            />
          </div>
        </aside>

        <div className={cn('min-w-0 lg:min-h-0', !filePath && 'hidden lg:block')}>
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
  // Snapshot of the file as editing began: the dirty-tracking baseline and
  // the optimistic-concurrency token for the save. Pinned at edit start so a
  // background refetch (e.g. window-focus) can't silently shift either under
  // an active edit — that would defeat the server's 409 conflict check.
  const editBase = useRef<{ sha: string; text: string } | null>(null);
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
  const [wrap, setWrapState] = useState(() => localStorage.getItem(WRAP_KEY) === 'on');
  const setWrap = (next: boolean) => {
    setWrapState(next);
    localStorage.setItem(WRAP_KEY, next ? 'on' : 'off');
  };
  // SVG opens as a rendered preview by default, toggleable to the editable
  // source view; editing always shows the editor.
  const isSvg = isSvgPath(path);
  const [svgSource, setSvgSource] = useState(false);

  const loadedText = file?.text ?? '';
  const dirty = editing && buffer !== (editBase.current?.text ?? '');

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

  // 409 recovery: pull the branch's current revision and rebase the edit
  // session onto it — the buffer (the user's work) is kept, dirty is
  // recomputed against the fresh text, and the next save carries the fresh
  // sha instead of bouncing off the same conflict again.
  const rebaseOntoLatest = () =>
    void queryClient
      .fetchQuery({ ...repoFileQuery(repoId, refName, path), staleTime: 0 })
      .then((latest) => {
        editBase.current = { sha: latest.sha, text: latest.text ?? '' };
        toast.success('Reloaded the latest revision — review your edit, then save again.');
      })
      .catch(onApiError);

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
        base_sha: editBase.current?.sha ?? file?.sha ?? null,
        content: buffer,
        message,
        mode,
      }),
    onSuccess: (result) => {
      setSaveOpen(false);
      setEditing(false);
      editBase.current = null;
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
        // Keep the buffer — rebasing swaps the baseline under it so the
        // next save goes through against the branch's current revision.
        toast.error('The file changed on the branch since you opened it.', {
          action: { label: 'Load latest', onClick: rebaseOntoLatest },
        });
        return;
      }
      onApiError(err);
    },
  });

  // ⌘S with focus outside the editor (the editor's own keymap covers focus
  // inside it). Always intercepted while editing so the browser's save-page
  // dialog never appears mid-edit.
  useHotkeys(
    'mod+s',
    () => {
      if (dirty) {
        setMessage(`Update ${path}`);
        setSaveOpen(true);
      }
    },
    { enabled: editing, preventDefault: true, enableOnFormTags: true },
    [editing, dirty, path],
  );

  // The save dialog's change preview — computed only while the dialog is
  // open; megafiles degrade to a bare summary instead of running the diff.
  const preview = useMemo(() => {
    if (!saveOpen || !editBase.current) return null;
    const base = editBase.current.text;
    const lines = Math.max(base.split('\n').length, buffer.split('\n').length);
    if (lines > DIFF_PREVIEW_MAX_LINES) return { tooLarge: true as const };
    const ops = diffLines(base, buffer);
    return { tooLarge: false as const, stats: diffStats(ops), hunks: toHunks(ops) };
  }, [saveOpen, buffer]);

  const backButton = (
    <Button variant="ghost" size="sm" className="lg:hidden" onClick={onBack}>
      <ArrowLeft className="size-3.5" aria-hidden /> Files
    </Button>
  );

  if (fileQuery.isPending) {
    // Editor-shaped skeleton: the frame lands at its final size immediately,
    // only the text area shimmers — no layout jump when content arrives.
    return (
      <div className="lg:flex lg:h-full lg:min-h-0 lg:flex-col">
        {backButton}
        <div
          className="mt-2 h-[calc(100dvh-16rem)] min-h-96 animate-pulse space-y-2.5 overflow-hidden rounded-lg border border-line bg-surface p-4 lg:h-auto lg:min-h-0 lg:flex-1"
          role="status"
          aria-label="Loading file"
        >
          {[82, 60, 74, 45, 68, 38, 55, 71, 30, 64].map((w, i) => (
            // SAFETY: widths are a fixed list — index keys are stable.
            <div key={i} className="h-3 rounded bg-raised/70" style={{ width: `${w}%` }} />
          ))}
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
          <Button
            variant="secondary"
            size="sm"
            className="mt-3"
            onClick={() => void fileQuery.refetch()}
          >
            Retry
          </Button>
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
  // Previewable binaries (images, PDFs, fonts) render in the editor's frame.
  // Keyed on content_base64 presence, not `binary`, so symlinks/submodules
  // (no content on either provider) and stale cached JSON without the field
  // fall through to the card below. No Edit button here — the text-only save
  // flow stays unreachable for binaries, exactly like today's card.
  const binaryPreview = binaryPreviewKind(path);
  if (binaryPreview && file.content_base64) {
    return (
      <div className="lg:flex lg:h-full lg:min-h-0 lg:flex-col">
        <div className="flex flex-wrap items-center gap-2 pb-2">
          {backButton}
          <Muted className="ml-auto font-mono text-xs">{file.size} bytes</Muted>
        </div>
        <div className="h-[calc(100dvh-16rem)] min-h-96 overflow-hidden rounded-lg border border-line bg-surface lg:h-auto lg:min-h-0 lg:flex-1">
          {binaryPreview.kind === 'image' ? (
            <ImagePreview base64={file.content_base64} mime={binaryPreview.mime} alt={path} />
          ) : binaryPreview.kind === 'pdf' ? (
            <PdfPreview base64={file.content_base64} title={path} />
          ) : (
            <FontPreview base64={file.content_base64} family={`preview-${file.sha.slice(0, 8)}`} />
          )}
        </div>
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
    editBase.current = { sha: file.sha, text: file.text ?? '' };
    setBuffer(file.text ?? '');
    setEditing(true);
  };
  const discard = () => {
    if (dirty && !window.confirm('Discard your unsaved changes?')) return;
    setEditing(false);
    setBuffer('');
    editBase.current = null;
  };
  const openSave = () => {
    setMessage(`Update ${path}`);
    setSaveOpen(true);
  };

  return (
    <div className="lg:flex lg:h-full lg:min-h-0 lg:flex-col">
      <div className="flex flex-wrap items-center gap-2 pb-2">
        {backButton}
        <span className="ml-auto flex items-center gap-2">
          {dirty ? (
            <span className="flex items-center gap-1.5 font-mono text-[11px] text-warn">
              <span className="size-1.5 rounded-full bg-warn" aria-hidden />
              Unsaved changes
            </span>
          ) : null}
          {isSvg && !editing ? (
            <button
              type="button"
              onClick={() => setSvgSource(!svgSource)}
              aria-pressed={!svgSource}
              title={svgSource ? 'Preview' : 'View source'}
              className={cn(
                'cursor-pointer rounded-md p-1.5 transition-colors',
                !svgSource
                  ? 'bg-accent/10 text-accent-bright'
                  : 'text-mute hover:bg-raised/60 hover:text-ink',
              )}
            >
              {svgSource ? (
                <Eye className="size-3.5" aria-hidden />
              ) : (
                <Code className="size-3.5" aria-hidden />
              )}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setWrap(!wrap)}
            aria-pressed={wrap}
            title={wrap ? 'Unwrap long lines' : 'Wrap long lines'}
            className={cn(
              'cursor-pointer rounded-md p-1.5 transition-colors',
              wrap
                ? 'bg-accent/10 text-accent-bright'
                : 'text-mute hover:bg-raised/60 hover:text-ink',
            )}
          >
            <WrapText className="size-3.5" aria-hidden />
          </button>
          {editing ? (
            <>
              <Button variant="ghost" size="sm" onClick={discard}>
                Discard
              </Button>
              <Button size="sm" onClick={openSave} disabled={!dirty} title="Save (⌘S)">
                {mode === 'commit' ? `Save · commit to ${refName}` : 'Save · via PR'}
                <Kbd className="ml-1">⌘S</Kbd>
              </Button>
            </>
          ) : (
            <Button variant="secondary" size="sm" onClick={startEditing}>
              <Pencil className="size-3.5" aria-hidden /> Edit
            </Button>
          )}
        </span>
      </div>
      <div className="h-[calc(100dvh-16rem)] min-h-96 overflow-hidden rounded-lg border border-line bg-surface lg:h-auto lg:min-h-0 lg:flex-1">
        {isSvg && !svgSource && !editing ? (
          <SvgPreview text={loadedText} alt={path} />
        ) : (
          <Suspense
            fallback={
              <div className="h-full animate-pulse bg-surface" aria-label="Loading editor" />
            }
          >
            <CodeEditor
              value={editing ? buffer : loadedText}
              onChange={setBuffer}
              path={path}
              readOnly={!editing}
              wrap={wrap}
              onSave={() => {
                if (editing && dirty) openSave();
              }}
            />
          </Suspense>
        )}
      </div>

      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent className="max-w-2xl">
          <DialogTitle className="pr-8 text-[0.95rem] font-medium break-words">
            Save {path}
          </DialogTitle>
          {preview ? (
            preview.tooLarge ? (
              <p className="mt-3 text-xs text-mute">
                File is too large for a change preview — saving still works.
              </p>
            ) : (
              <div className="mt-3">
                <p className="font-mono text-[11px] tracking-[0.14em] text-mute uppercase">
                  Changes <span className="text-go-bright">+{preview.stats.additions}</span>{' '}
                  <span className="text-danger">&minus;{preview.stats.deletions}</span>
                </p>
                <DiffPreview hunks={preview.hunks} />
              </div>
            )
          ) : null}
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

// Compact hunk view for the save dialog: what's about to land on the
// branch, with a couple of context lines per hunk.
function DiffPreview({ hunks }: { hunks: DiffHunk[] }) {
  if (hunks.length === 0) {
    return <p className="mt-2 text-xs text-mute">No changes.</p>;
  }
  return (
    <div className="mt-2 max-h-56 overflow-auto rounded-md border border-line bg-bg font-mono text-xs leading-5">
      {hunks.map((hunk, i) => (
        <div
          key={`${hunk.oldStart}:${hunk.newStart}`}
          className={cn(i > 0 && 'border-t border-line/70')}
        >
          <p className="bg-surface/80 px-2 py-0.5 text-[10px] text-mute select-none">
            @@ line {hunk.oldStart} &rarr; {hunk.newStart}
          </p>
          {hunk.ops.map((op, j) => (
            <p
              // SAFETY: ops render in fixed order within a static hunk — index keys are stable.
              key={j}
              className={cn(
                'flex px-2 whitespace-pre',
                op.kind === 'add' && 'bg-go/10 text-go-bright',
                op.kind === 'del' && 'bg-danger/10 text-danger',
                op.kind === 'same' && 'text-ink-dim',
              )}
            >
              <span className="w-4 shrink-0 select-none">
                {op.kind === 'add' ? '+' : op.kind === 'del' ? '-' : ' '}
              </span>
              {op.text}
            </p>
          ))}
        </div>
      ))}
    </div>
  );
}
