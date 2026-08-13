import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { PatchDiff, type DiffLineAnnotation } from '@pierre/diffs/react';
import {
  ChevronDown,
  ChevronRight,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { ApiCockpitComment, ApiFeatureDetail } from '../../shared/api-types.ts';
import { api, ApiError } from '../lib/api.ts';
import { sentence } from '../lib/format.ts';
import { featureQuery, FIX_TERMINAL, GENERATION_STOPPED } from '../lib/queries.ts';
import { cn } from '../lib/utils.ts';
import { AgentRunLog } from '../components/agent-run-log.tsx';
import { ConfirmButton } from '../components/confirm-button.tsx';
import { ensureDiffStyles } from '../components/diff-styles.ts';
import { FILE_STATUS_DOT, FileTree } from '../components/file-tree.tsx';
import { Markdown } from '../components/markdown.tsx';
import { Muted, PageTitle, SectionHeading } from '../components/section.tsx';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '../components/ui/accordion.tsx';
import { Button } from '../components/ui/button.tsx';
import { Pill } from '../components/ui/pill.tsx';
import { Table, Td } from '../components/ui/table.tsx';
import { Textarea } from '../components/ui/input.tsx';

// The factory PR cockpit: one screen for reviewing a factory PR without
// GitHub — demo video, acceptance evidence, review verdicts, the merge
// action, and the full diff. The diff pane runs wide (AppShell widens the
// container for this route) with a sticky file tree for navigation; each
// file is a collapsible card. Select a line range to leave a review
// comment; submitting it dispatches the fix agent against that finding.

type CockpitFile = ApiFeatureDetail['files'][number];

type Selection = {
  file: string;
  startLine: number;
  endLine: number;
  side: 'additions' | 'deletions';
};

interface CommentMeta {
  comment?: ApiCockpitComment;
  composer?: boolean;
}

const VERDICT_BADGE: Record<string, string> = { pass: '✅', fail: '❌', skip: '⚪' };

function onApiError(err: unknown) {
  toast.error(err instanceof ApiError ? err.message : 'Request failed');
}

function CommentFixStatePill({ comment }: { comment: ApiCockpitComment }) {
  if (comment.fix_status === 'fixed') return <Pill tone="on">Fixed</Pill>;
  if (comment.fix_status === 'no_changes') return <Pill tone="neutral">No changes needed</Pill>;
  if (comment.fix_status === 'tests_failed') return <Pill tone="warn">Tests failed</Pill>;
  if (comment.fix_status === 'failed') return <Pill tone="red">Fix failed</Pill>;
  if (comment.status === 'dispatched') return <Pill tone="running">Fixing…</Pill>;
  return null;
}

function CommentCard({ comment }: { comment: ApiCockpitComment }) {
  return (
    <div className="m-2 rounded-md border border-line-2 border-l-2 border-l-accent bg-surface px-3 py-2 text-[0.82rem]">
      <div className="mb-1 flex items-center gap-1.5 text-xs text-mute">
        <strong>@{comment.author}</strong>
        <CommentFixStatePill comment={comment} />
      </div>
      <Markdown className="markdown-body--compact">{comment.body}</Markdown>
    </div>
  );
}

function Composer({
  selection,
  featureId,
  onDone,
  onCancel,
}: {
  selection: Selection;
  featureId: number;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState('');
  const submit = useMutation({
    mutationFn: () =>
      api.post(`/api/factory/features/${featureId}/comments`, {
        path: selection.file,
        line: selection.endLine,
        side: selection.side,
        body: body.trim(),
      }),
    onSuccess: () => {
      toast.success('Comment added');
      onDone();
    },
    onError: onApiError,
  });

  return (
    <div className="m-2 rounded-md border border-line-2 border-l-2 border-l-accent bg-surface px-3 py-2">
      <div className="mb-1.5 text-xs text-mute">
        Comment on line {selection.endLine} — it'll be addressed the next time you hit Submit.
      </div>
      <Textarea
        autoFocus
        className="min-h-20"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="What should change here?"
      />
      <div className="mt-2 flex gap-2">
        <Button
          size="sm"
          onClick={() => body.trim() && submit.mutate()}
          disabled={!body.trim()}
          loading={submit.isPending}
        >
          {submit.isPending ? 'Adding…' : 'Add comment'}
        </Button>
        <Button size="sm" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function FileDiff({
  data,
  file,
  diffStyle,
  onCommented,
}: {
  data: ApiFeatureDetail;
  file: CockpitFile;
  diffStyle: 'split' | 'unified';
  onCommented: () => void;
}) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const prOpen = data.pr?.state === 'open';

  const annotations = useMemo(() => {
    const list: DiffLineAnnotation<CommentMeta>[] = data.comments
      .filter((c) => c.path === file.filename)
      .map((c) => ({
        side: (c.side === 'deletions' ? 'deletions' : 'additions') as 'additions' | 'deletions',
        lineNumber: c.line,
        metadata: { comment: c },
      }));
    if (selection) {
      list.push({
        side: selection.side,
        lineNumber: selection.endLine,
        metadata: { composer: true },
      });
    }
    return list;
  }, [data.comments, file.filename, selection]);

  const onSelectionEnd = useCallback(
    (range: unknown) => {
      const r = range as { start: number; end: number; side?: string; endSide?: string } | null;
      if (!r || !Number.isFinite(r.start) || !Number.isFinite(r.end)) return;
      setSelection({
        file: file.filename,
        startLine: Math.min(r.start, r.end),
        endLine: Math.max(r.start, r.end),
        side: ((r.endSide ?? r.side) === 'deletions' ? 'deletions' : 'additions') as
          | 'additions'
          | 'deletions',
      });
    },
    [file.filename],
  );

  if (!file.patch) {
    return (
      <p className="px-3 py-3 text-xs text-mute">
        Diff not rendered (binary, renamed, or too large) — see the PR on GitHub.
      </p>
    );
  }
  return (
    <div className="diffs-scope rounded-none border-0">
      <PatchDiff
        patch={file.patch}
        lineAnnotations={annotations}
        renderAnnotation={(a: DiffLineAnnotation<CommentMeta>) =>
          a.metadata?.composer && selection ? (
            <Composer
              selection={selection}
              featureId={data.feature.id}
              onDone={() => {
                setSelection(null);
                onCommented();
              }}
              onCancel={() => setSelection(null)}
            />
          ) : a.metadata?.comment ? (
            <CommentCard comment={a.metadata.comment} />
          ) : null
        }
        options={{
          theme: 'pierre-dark',
          diffStyle,
          // The card header (FileSection) owns the filename/stats row.
          disableFileHeader: true,
          enableLineSelection: prOpen,
          onLineSelectionEnd: onSelectionEnd,
        }}
      />
    </div>
  );
}

// One collapsible file card: sticky header (path, status, ±counts, comment
// count) over the diff surface.
function FileSection({
  data,
  file,
  collapsed,
  commentCount,
  diffStyle,
  onToggle,
  onCommented,
  sectionRef,
}: {
  data: ApiFeatureDetail;
  file: CockpitFile;
  collapsed: boolean;
  commentCount: number;
  diffStyle: 'split' | 'unified';
  onToggle: () => void;
  onCommented: () => void;
  sectionRef: (el: HTMLElement | null) => void;
}) {
  const dir = file.filename.includes('/')
    ? file.filename.slice(0, file.filename.lastIndexOf('/') + 1)
    : '';
  const base = file.filename.slice(dir.length);
  return (
    <section
      ref={sectionRef}
      data-file={file.filename}
      className="mt-3 scroll-mt-3 overflow-clip rounded-lg border border-line bg-surface"
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className={cn(
          'flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-xs hover:bg-raised/50',
          'lg:sticky lg:top-0 lg:z-10 lg:bg-surface',
          !collapsed && 'border-b border-line',
        )}
      >
        {collapsed ? (
          <ChevronRight className="size-3.5 shrink-0 text-mute" aria-hidden />
        ) : (
          <ChevronDown className="size-3.5 shrink-0 text-mute" aria-hidden />
        )}
        <span
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            FILE_STATUS_DOT[file.status] ?? 'bg-mute',
          )}
          title={file.status}
        />
        <span className="min-w-0 truncate font-mono font-medium">
          {dir ? <span className="font-normal text-mute">{dir}</span> : null}
          {base}
        </span>
        {commentCount > 0 ? (
          <span className="flex shrink-0 items-center gap-1 text-mute">
            <MessageSquare className="size-3" aria-hidden />
            {commentCount}
          </span>
        ) : null}
        <span className="ml-auto shrink-0 tabular-nums">
          {file.additions > 0 ? (
            <span className="text-accent-bright">+{file.additions}</span>
          ) : null}{' '}
          {file.deletions > 0 ? <span className="text-danger">−{file.deletions}</span> : null}
        </span>
      </button>
      {collapsed ? null : (
        <FileDiff data={data} file={file} diffStyle={diffStyle} onCommented={onCommented} />
      )}
    </section>
  );
}

export default function FeaturePage() {
  ensureDiffStyles();
  const { featureId } = useParams({ from: '/factory/features/$featureId' });
  const id = Number(featureId);
  const queryClient = useQueryClient();
  const { data } = useSuspenseQuery(featureQuery(id));
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['feature', id] });
  };

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Side-by-side needs width; unified is the sane default on narrow screens.
  const [diffStyle, setDiffStyleState] = useState<'split' | 'unified'>(() => {
    const stored = localStorage.getItem('turbodiff.diffStyle');
    if (stored === 'split' || stored === 'unified') return stored;
    return window.matchMedia('(min-width: 1024px)').matches ? 'split' : 'unified';
  });
  const setDiffStyle = (style: 'split' | 'unified') => {
    setDiffStyleState(style);
    localStorage.setItem('turbodiff.diffStyle', style);
  };
  const [activeFile, setActiveFile] = useState<string | null>(null);
  // The desktop file-tree panel collapses to a thin rail; remembered across
  // visits since it's a workspace-layout preference.
  const [treeOpen, setTreeOpenState] = useState(
    () => localStorage.getItem('turbodiff.fileTree') !== 'closed',
  );
  const setTreeOpen = (open: boolean) => {
    setTreeOpenState(open);
    localStorage.setItem('turbodiff.fileTree', open ? 'open' : 'closed');
  };
  const sectionEls = useRef(new Map<string, HTMLElement>());

  const commentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of data.comments) counts.set(c.path, (counts.get(c.path) ?? 0) + 1);
    return counts;
  }, [data.comments]);

  const toggleFile = (filename: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(filename)) next.delete(filename);
      else next.add(filename);
      return next;
    });

  // Tree click: expand the file if needed, then scroll its card into view.
  const jumpToFile = useCallback((filename: string) => {
    setCollapsed((prev) => {
      if (!prev.has(filename)) return prev;
      const next = new Set(prev);
      next.delete(filename);
      return next;
    });
    setActiveFile(filename);
    requestAnimationFrame(() => {
      sectionEls.current.get(filename)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, []);

  // Scroll spy: highlight the file nearest the top of the viewport in the tree.
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const top = visible[0]?.target.getAttribute('data-file');
        if (top) setActiveFile(top);
      },
      { rootMargin: '0px 0px -70% 0px' },
    );
    for (const el of sectionEls.current.values()) observer.observe(el);
    return () => observer.disconnect();
  }, [data.files]);

  const merge = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; conflict?: boolean; resolving?: boolean }>(
        `/api/factory/features/${id}/merge`,
      ),
    onSuccess: (result) => {
      toast.success(
        result.resolving
          ? 'Merge conflict detected — auto-resolving…'
          : 'Pull request merged',
      );
      refresh();
    },
    onError: onApiError,
  });
  const retryGeneration = useMutation({
    mutationFn: () => api.post(`/api/factory/features/${id}/retry`),
    onSuccess: () => {
      toast.success('Generation retried — the run is queued');
      refresh();
    },
    onError: onApiError,
  });
  const submitBatch = useMutation({
    mutationFn: () => api.post(`/api/factory/features/${id}/comments/submit`),
    onSuccess: () => {
      toast.success('Comments submitted — the fix agent is dispatched');
      refresh();
    },
    onError: onApiError,
  });
  const pendingCount = data.comments.filter((c) => c.status === 'open').length;
  const batchRunning = data.comments.some(
    (c) => c.status === 'dispatched' && !FIX_TERMINAL.has(c.fix_status ?? ''),
  );

  if (!data.pr) {
    const stopped = GENERATION_STOPPED.has(data.feature.status);
    return (
      <div className="animate-rise">
        <PageTitle
          titleClassName="text-base sm:text-xl"
          aside={
            stopped ? (
              <Pill tone="red">{sentence(data.feature.status)}</Pill>
            ) : (
              <Pill tone="running">Generating</Pill>
            )
          }
        >
          {data.feature.title}
        </PageTitle>
        {stopped ? (
          <>
            <p className="mt-4">
              <Muted>Generation stopped without a pull request.</Muted>
            </p>
            {data.feature.error ? (
              <p className="mt-2 text-[0.85rem] text-danger">{data.feature.error}</p>
            ) : null}
            <div className="mt-4">
              <Button onClick={() => retryGeneration.mutate()} loading={retryGeneration.isPending}>
                Retry generation
              </Button>
            </div>
          </>
        ) : (
          <p className="mt-4">
            <Muted>No pull request yet — generation is {data.feature.status}.</Muted>
          </p>
        )}
      </div>
    );
  }

  const prState = data.pr.state;
  const v = data.verification;
  const totalAdditions = data.files.reduce((n, f) => n + f.additions, 0);
  const totalDeletions = data.files.reduce((n, f) => n + f.deletions, 0);

  const fileTree = (
    <FileTree
      files={data.files}
      activeFile={activeFile}
      commentCounts={commentCounts}
      onSelect={jumpToFile}
    />
  );

  return (
    <div className="animate-rise">
      <h1 className="text-base leading-snug font-medium break-words sm:text-xl">
        {data.feature.title}
      </h1>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Pill tone={prState === 'merged' ? 'on' : prState === 'open' ? 'running' : 'red'}>
          {sentence(prState)}
        </Pill>
        {data.pr.mergeable_state === 'dirty' ? <Pill tone="red">Merge conflict</Pill> : null}
        {v ? (
          <Pill tone={v.status === 'passed' ? 'on' : v.status === 'running' ? 'running' : 'red'}>
            Verify: {v.status}
            {v.status === 'passed'
              ? ` (${v.total}/${v.total})`
              : v.status === 'failed'
                ? ` (${v.failed} unmet)`
                : ''}
          </Pill>
        ) : null}
      </div>
      <p className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-mute sm:text-[0.85rem]">
        <span className="truncate font-mono">{data.repo}</span>
        <span>·</span>
        <a
          href={data.pr.html_url}
          target="_blank"
          rel="noopener"
          className="font-mono text-accent-bright hover:underline"
        >
          PR #{data.feature.pr_number}
        </a>
        <span>·</span>
        <span>
          {data.pr.changed_files} files{' '}
          <span className="text-accent-bright">+{data.pr.additions}</span>{' '}
          <span className="text-danger">−{data.pr.deletions}</span>
        </span>
      </p>

      {/* One action row: merging is the primary CTA, submitting review
          comments the secondary one beside it. */}
      {prState === 'open' || pendingCount > 0 || batchRunning ? (
        <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:items-center">
          {prState === 'open' ? (
            <ConfirmButton
              className="w-full sm:w-auto"
              title="Merge pull request?"
              description={`This merges PR #${data.feature.pr_number} into ${data.repo} on GitHub.`}
              confirmLabel="Merge"
              onConfirm={() => merge.mutate()}
              busy={merge.isPending}
            >
              Merge pull request
            </ConfirmButton>
          ) : null}
          {pendingCount > 0 || batchRunning ? (
            <Button
              variant="secondary"
              className="w-full sm:w-auto"
              onClick={() => submitBatch.mutate()}
              disabled={pendingCount === 0 || batchRunning}
              loading={submitBatch.isPending}
            >
              {batchRunning
                ? 'Fix in progress…'
                : `Submit ${pendingCount} comment${pendingCount === 1 ? '' : 's'}`}
            </Button>
          ) : null}
        </div>
      ) : null}

      <div
        className={cn(
          'lg:grid lg:items-start lg:gap-6 lg:transition-[grid-template-columns] lg:duration-200',
          treeOpen ? 'lg:grid-cols-[16rem_minmax(0,1fr)]' : 'lg:grid-cols-[2.25rem_minmax(0,1fr)]',
        )}
      >
        {/* Sticky file tree, desktop only — collapsible to a thin rail; small
            screens get a jump list above the diff instead. */}
        <aside className="hidden lg:sticky lg:top-4 lg:flex lg:max-h-[calc(100dvh-2rem)] lg:flex-col lg:pt-9">
          {treeOpen ? (
            <>
              <div className="flex items-center justify-between gap-2 px-1.5 pb-2">
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
              <div className="mb-2 px-1.5 text-xs text-mute">
                {data.files.length} file{data.files.length === 1 ? '' : 's'} ·{' '}
                <span className="text-accent-bright">+{totalAdditions}</span>{' '}
                <span className="text-danger">−{totalDeletions}</span>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto pb-2">{fileTree}</div>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setTreeOpen(true)}
              title="Show the file tree"
              aria-label="Show the file tree"
              className="flex cursor-pointer flex-col items-center gap-2 rounded-md border border-line bg-surface px-1.5 py-2 text-mute transition-colors hover:border-line-2 hover:text-ink"
            >
              <PanelLeftOpen className="size-3.5" aria-hidden />
              <span className="font-mono text-[10px] tabular-nums [writing-mode:vertical-rl]">
                {data.files.length} files
              </span>
            </button>
          )}
        </aside>

        <div className="min-w-0">
          <div className="max-w-3xl">
            {data.demo ? (
              <>
                <SectionHeading>Demo</SectionHeading>
                <video
                  className="w-full rounded-xl bg-black border border-line-2 shadow-2xl shadow-black/60"
                  controls
                  autoPlay
                  muted
                  loop
                  playsInline
                  src={data.demo.url}
                />
                {data.demo.caption ? (
                  <p className="mt-2 text-xs leading-relaxed text-mute">{data.demo.caption}</p>
                ) : null}
              </>
            ) : null}

            {data.criteria.length > 0 ? (
              <>
                <SectionHeading>Acceptance criteria</SectionHeading>
                <Accordion type="single" collapsible defaultValue="criteria">
                  <AccordionItem value="criteria">
                    <AccordionTrigger
                      aside={
                        <span className="text-xs text-mute tabular-nums">
                          {data.criteria.filter((c) => c.verdict === 'pass').length}/
                          {data.criteria.length} passed
                        </span>
                      }
                    >
                      {data.criteria.length} criteri{data.criteria.length === 1 ? 'on' : 'a'}
                    </AccordionTrigger>
                    <AccordionContent>
                      <Table className="mt-0">
                        <tbody>
                          {data.criteria.map((crit, i) => (
                            <tr key={i}>
                              <Td className={cn('w-6', i === 0 && 'border-t-0')}>
                                {VERDICT_BADGE[crit.verdict ?? ''] ?? '⚪'}
                              </Td>
                              <Td className={cn(i === 0 && 'border-t-0')}>
                                {crit.text}
                                {crit.note ? (
                                  <div className="text-xs text-mute">{crit.note}</div>
                                ) : null}
                                {crit.screenshot_url ? (
                                  <div className="mt-1">
                                    <img
                                      src={crit.screenshot_url}
                                      alt=""
                                      className="max-h-40 rounded-xl bg-black border border-line-2 shadow-2xl shadow-black/60"
                                    />
                                  </div>
                                ) : null}
                              </Td>
                            </tr>
                          ))}
                        </tbody>
                      </Table>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              </>
            ) : null}

            {data.reviews.length > 0 ? (
              <>
                <SectionHeading>Reviews</SectionHeading>
                <Accordion type="multiple">
                  {data.reviews.map((r, i) => (
                    <AccordionItem key={i} value={String(i)}>
                      <AccordionTrigger>
                        {r.author ?? 'Unknown'} · {sentence(r.state.toLowerCase())}
                      </AccordionTrigger>
                      <AccordionContent>
                        <Markdown>{r.body || '(no body)'}</Markdown>
                      </AccordionContent>
                    </AccordionItem>
                  ))}
                </Accordion>
              </>
            ) : null}

            {data.plan ? (
              <>
                <SectionHeading>Plan</SectionHeading>
                <Accordion type="single" collapsible>
                  <AccordionItem value="plan">
                    <AccordionTrigger>Implementation plan (approved)</AccordionTrigger>
                    <AccordionContent>
                      <Markdown>{data.plan}</Markdown>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              </>
            ) : null}

            <AgentRunLog runs={data.runs} />
          </div>

          <SectionHeading
            aside={
              <span className="flex flex-wrap items-center gap-1">
                <span
                  className="mr-1 inline-flex overflow-hidden rounded-md border border-line-2/70"
                  role="group"
                  aria-label="Diff layout"
                >
                  {(['unified', 'split'] as const).map((style) => (
                    <button
                      key={style}
                      type="button"
                      aria-pressed={diffStyle === style}
                      onClick={() => setDiffStyle(style)}
                      className={cn(
                        'cursor-pointer px-2.5 py-1 text-xs transition-colors',
                        diffStyle === style
                          ? 'bg-raised text-accent-bright'
                          : 'text-mute hover:text-ink',
                      )}
                    >
                      {style === 'split' ? 'Side-by-side' : 'Unified'}
                    </button>
                  ))}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setCollapsed(new Set(data.files.map((f) => f.filename)))}
                >
                  Collapse all
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setCollapsed(new Set())}>
                  Expand all
                </Button>
              </span>
            }
          >
            Diff
          </SectionHeading>
          {prState === 'open' ? (
            <Muted className="block">
              Select a line range in the diff to comment — click Submit to address every pending
              comment in one pass.
            </Muted>
          ) : null}

          <Accordion type="single" collapsible className="mt-3 lg:hidden">
            <AccordionItem value="files">
              <AccordionTrigger className="text-xs text-mute">
                {data.files.length} file{data.files.length === 1 ? '' : 's'} changed — jump to a
                file
              </AccordionTrigger>
              <AccordionContent>{fileTree}</AccordionContent>
            </AccordionItem>
          </Accordion>

          {data.files.map((f) => (
            <FileSection
              key={f.filename}
              data={data}
              file={f}
              diffStyle={diffStyle}
              collapsed={collapsed.has(f.filename)}
              commentCount={commentCounts.get(f.filename) ?? 0}
              onToggle={() => toggleFile(f.filename)}
              onCommented={refresh}
              sectionRef={(el) => {
                if (el) sectionEls.current.set(f.filename, el);
                else sectionEls.current.delete(f.filename);
              }}
            />
          ))}
          {data.more_files > 0 ? (
            <Muted className="mt-3 block">
              …and {data.more_files} more files — see the PR on GitHub.
            </Muted>
          ) : null}
        </div>
      </div>
    </div>
  );
}
