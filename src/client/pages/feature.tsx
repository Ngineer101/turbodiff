import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import type { DiffLineAnnotation, SelectedLineRange } from '@pierre/diffs/react';
import { ChevronDown, ChevronRight, MessageSquare } from 'lucide-react';
import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import type {
  ApiCockpitComment,
  ApiFeatureDetail,
  ApiMe,
  ApiVerificationSummary,
} from '../../shared/api-types.ts';
import { api, ApiError } from '../lib/api.ts';
import { useDictation } from '../lib/dictation.ts';
import { sentence } from '../lib/format.ts';
import { applyOptimistic, optimisticId, optimisticNow } from '../lib/optimistic.ts';
import {
  chatQuery,
  featureDiffQuery,
  featureQuery,
  FIX_TERMINAL,
  GENERATION_STOPPED,
  retryQueued,
} from '../lib/queries.ts';
import { RAIL_OPEN_KEY, RAIL_WIDTH_KEY, railRestWidth } from '../lib/chat-rail.ts';
import { RailSlotContext } from '../lib/rail-slot.ts';
import { cn } from '../lib/utils.ts';
import { AgentRunLog } from '../components/agent-run-log.tsx';
import { ConfirmButton } from '../components/confirm-button.tsx';
import type { CockpitCommentMeta } from '../components/cockpit-patch-diff.tsx';
import { CertStrip, Lamp, Serial, Stamp, type LampTone } from '../components/identity.tsx';
import { FILE_STATUS_DOT, FileTree } from '../components/file-tree.tsx';
import { Markdown } from '../components/markdown.tsx';
import { MicButton } from '../components/mic-button.tsx';
import { Muted, PageTitle, SectionHeading } from '../components/section.tsx';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '../components/ui/accordion.tsx';
import { Button } from '../components/ui/button.tsx';
import { BlockLabel, Panel } from '../components/ui/panel.tsx';
import { Pill } from '../components/ui/pill.tsx';
import { Card } from '../components/ui/card.tsx';
import { Textarea } from '../components/ui/input.tsx';

// The factory PR cockpit: one screen for reviewing a factory PR without
// GitHub — demo video, acceptance evidence, review verdicts, the merge
// action, and the full diff. The diff pane runs wide (AppShell widens the
// container for this route) with a sticky file tree for navigation; each
// file is a collapsible card. Select a line range to leave a review
// comment; submitting it dispatches the fix agent against that finding.

type CockpitFile = ApiFeatureDetail['files'][number];

const CockpitPatchDiff = lazy(() =>
  import('../components/cockpit-patch-diff.tsx').then((module) => ({
    default: module.CockpitPatchDiff,
  })),
);
const CockpitDiffWorkspace = lazy(() =>
  import('../components/cockpit-patch-diff.tsx').then((module) => ({
    default: module.CockpitDiffWorkspace,
  })),
);
// The agent chat rail is its own chunk (the route stays within its
// performance budget); while it loads, RailPlaceholder holds its width.
const ChatRail = lazy(() =>
  import('../components/chat-rail.tsx').then((module) => ({ default: module.ChatRail })),
);

// Reserve the rail's resting width from the saved preference so the page
// doesn't reflow when the real rail mounts. Below lg the rail is a sheet
// and reserves nothing.
function RailPlaceholder() {
  const width = railRestWidth(
    localStorage.getItem(RAIL_OPEN_KEY),
    localStorage.getItem(RAIL_WIDTH_KEY),
  );
  return (
    <aside
      aria-hidden
      style={{ width }}
      className="sticky top-0 hidden h-dvh shrink-0 border-l border-line bg-surface/50 lg:block"
    />
  );
}

type Selection = {
  file: string;
  startLine: number;
  endLine: number;
  side: 'additions' | 'deletions';
};

function onApiError<T>(err: T) {
  toast.error(err instanceof ApiError ? err.message : 'Request failed');
}

// Criterion verdicts in the proof ledger: mono glyphs, not emoji — the
// ledger is a document, and its marks should typeset like one.
function VerdictMark({ verdict }: { verdict: string | null }) {
  if (verdict === 'pass') return <span className="font-mono text-go-bright">✓</span>;
  if (verdict === 'fail') return <span className="font-mono text-danger">✗</span>;
  if (verdict === 'skip') return <span className="font-mono text-mute">—</span>;
  return <span className="font-mono text-mute">○</span>;
}

// The cockpit's go/no-go board: one station per gate a factory PR passes
// through. Every verdict is also text, so the lamps are reinforcement, not
// the only signal.
type Station = { label: string; verdict: string; tone: LampTone; pulse?: boolean };

// The Verify lamp. A merged PR's unfinished (or sweep-errored) verification
// is moot — the human already shipped it — so those states show GO. Completed
// verdicts (passed / N UNMET) still show their truth even after merge.
function verifyStation(v: ApiVerificationSummary | null, merged: boolean): Station {
  const unresolved = !v || v.status === 'running' || v.status === 'stalled' || v.status === 'error';
  if (merged && unresolved) return { label: 'Verify', verdict: 'GO', tone: 'go' };
  if (!v) return { label: 'Verify', verdict: 'QUEUED', tone: 'off' };
  switch (v.status) {
    case 'passed':
      return { label: 'Verify', verdict: 'GO', tone: 'go' };
    case 'running':
      return { label: 'Verify', verdict: 'POLLING', tone: 'hold', pulse: true };
    case 'stalled':
      // Presumed dead, not live — no pulse.
      return { label: 'Verify', verdict: 'STALLED', tone: 'abort' };
    case 'error':
      return { label: 'Verify', verdict: 'ERRORED', tone: 'abort' };
    default: // 'failed'
      return { label: 'Verify', verdict: `${v.failed} UNMET`, tone: 'abort' };
  }
}

function stationsFor(data: ApiFeatureDetail): Station[] {
  const v = data.verification;
  const lastReview = data.reviews.at(-1);
  const blocking =
    lastReview?.state === 'CHANGES_REQUESTED' ||
    Boolean(lastReview?.body.startsWith('**Verdict: REQUEST_CHANGES**'));
  const merged = data.pr?.state === 'merged';
  const conflict = data.pr?.mergeable_state === 'dirty';

  // No GitHub review yet is "polling" only while the lifecycle's review
  // stage is still live — a failed stage is a failure, not a wait.
  const lastReviewStage = data.lifecycle_runs
    .at(-1)
    ?.stages.filter((stage) => stage.stage === 'review')
    .at(-1);
  const build: Station = { label: 'Build', verdict: 'GO', tone: 'go' };
  const review: Station =
    data.reviews.length === 0
      ? lastReviewStage?.status === 'failed'
        ? { label: 'Review', verdict: 'FAILED', tone: 'abort' }
        : { label: 'Review', verdict: 'POLLING', tone: 'hold', pulse: true }
      : blocking
        ? { label: 'Review', verdict: 'NO-GO', tone: 'abort' }
        : { label: 'Review', verdict: 'GO', tone: 'go' };
  const verify = verifyStation(v, merged);
  const ship: Station = merged
    ? { label: 'Ship', verdict: 'MERGED', tone: 'go' }
    : conflict
      ? { label: 'Ship', verdict: 'CONFLICT', tone: 'abort' }
      : review.tone === 'go' && verify.tone === 'go'
        ? { label: 'Ship', verdict: 'READY', tone: 'hold' }
        : { label: 'Ship', verdict: 'HOLD', tone: 'off' };
  return [build, review, verify, ship];
}

// The criteria-conflict decision (see verifier.ts): a cockpit-comment fix
// diverged from the approved acceptance criteria, and the factory refused to
// auto-revert. The human either rewrites the contract or restores the plan —
// nothing proceeds until they say which.
function CriteriaConflictCard({
  featureId,
  criteria,
  proposed,
}: {
  featureId: number;
  criteria: string[];
  proposed: string[] | null;
}) {
  const [draft, setDraft] = useState((proposed ?? criteria).join('\n'));
  const queryClient = useQueryClient();
  const update = useMutation({
    mutationFn: () =>
      api.post(`/api/factory/features/${featureId}/criteria`, {
        criteria: draft
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
      }),
    onSuccess: () => {
      toast.success('Criteria updated — re-verifying against the new contract');
      void queryClient.invalidateQueries({ queryKey: ['feature', featureId] });
    },
    onError: onApiError,
  });
  const keep = useMutation({
    mutationFn: () => api.post(`/api/factory/features/${featureId}/criteria/keep`),
    onSuccess: () => {
      toast.success('Restoring the planned behavior — the fix agent is on it');
      void queryClient.invalidateQueries({ queryKey: ['feature', featureId] });
    },
    onError: onApiError,
  });
  return (
    <Card className="mt-4 max-w-xl border-warn/50">
      <div className="flex items-center gap-2">
        <Lamp tone="hold" />
        <span className="font-mono text-[11px] font-bold tracking-[0.18em] text-warn uppercase">
          Criteria conflict — your call
        </span>
      </div>
      <p className="mt-2 text-[0.85rem] text-ink-dim">
        Your review comment steered the code away from the approved acceptance criteria, and
        verification now fails against them. The factory won&rsquo;t revert your change without
        asking. Either edit the criteria below to match the new direction, or restore the planned
        behavior.
      </p>
      <Textarea
        className="mt-3 font-mono text-xs"
        rows={Math.min(8, Math.max(3, criteria.length + 1))}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        aria-label="Acceptance criteria, one per line"
      />
      <p className="mt-1 text-xs text-mute">
        {proposed
          ? 'Proposed rewrite drafted from your comments — edit freely, one criterion per line.'
          : 'One criterion per line.'}
      </p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <Button size="sm" loading={update.isPending} onClick={() => update.mutate()}>
          Update criteria &amp; re-verify
        </Button>
        <Button
          size="sm"
          variant="secondary"
          loading={keep.isPending}
          onClick={() => keep.mutate()}
        >
          Keep criteria — revert my change
        </Button>
      </div>
    </Card>
  );
}

function GoNoGoBoard({ data }: { data: ApiFeatureDetail }) {
  const stations = stationsFor(data);
  return (
    <div className="grid grid-cols-4 gap-2">
      {stations.map((s) => (
        <div
          key={s.label}
          className="rounded-md border border-line bg-surface-2 px-2 py-2.5 text-center"
        >
          <Lamp tone={s.tone} pulse={s.pulse} className="mx-auto mb-1.5 block" />
          <div className="font-mono text-[8.5px] font-medium tracking-[0.14em] text-mute uppercase">
            {s.label}
          </div>
          <div
            className={cn(
              'font-mono text-[10.5px] font-semibold tracking-[0.1em]',
              s.tone === 'go' && 'text-go-bright',
              s.tone === 'hold' && 'text-hold',
              s.tone === 'abort' && 'text-danger',
              s.tone === 'off' && 'text-mute',
            )}
          >
            {s.verdict}
          </div>
        </div>
      ))}
    </div>
  );
}

function LifecycleHistory({
  runs,
  onResume,
  resuming,
}: {
  runs: ApiFeatureDetail['lifecycle_runs'];
  // Re-run the failed stage of a run parked on a human decision.
  onResume: (runId: number) => void;
  resuming: boolean;
}) {
  if (runs.length === 0) return null;
  return (
    <>
      <SectionHeading>Factory lifecycle</SectionHeading>
      <Accordion type="multiple">
        {runs.map((run) => (
          <AccordionItem key={run.id} value={String(run.id)}>
            <AccordionTrigger
              aside={
                <span className="font-mono text-xs tracking-[0.08em] text-mute uppercase">
                  {sentence(run.status.replaceAll('_', ' '))}
                </span>
              }
            >
              {sentence(run.profile.replaceAll('_', ' '))} · {sentence(run.start_stage)} →{' '}
              {sentence(run.stop_after_stage)}
            </AccordionTrigger>
            <AccordionContent>
              <ol className="space-y-2">
                {run.stages.map((stage) => (
                  <li key={stage.id} className="flex items-start gap-3 text-sm">
                    <span
                      className={cn(
                        'mt-1.5 size-2 shrink-0 rounded-full',
                        stage.status === 'completed' && stage.verdict !== 'failed'
                          ? 'bg-go-bright'
                          : stage.status === 'failed' || stage.verdict === 'failed'
                            ? 'bg-danger'
                            : stage.status === 'running'
                              ? 'bg-hold lamp-glow-hold animate-pulse-dot'
                              : 'bg-line-2',
                      )}
                    />
                    <span className="min-w-0">
                      <span className="text-ink">{sentence(stage.stage)}</span>
                      {stage.attempt > 1 ? (
                        <span className="ml-2 font-mono text-xs text-mute">
                          attempt {stage.attempt}
                        </span>
                      ) : null}
                      <span className="ml-2 text-xs text-mute">
                        {sentence(stage.status)}
                        {stage.verdict === 'failed' ? ' · verification failed' : ''}
                      </span>
                      {stage.error ? (
                        <span className="mt-0.5 block text-xs text-danger">{stage.error}</span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ol>
              {run.status === 'awaiting_human' && run.stages.at(-1)?.status === 'failed' ? (
                <div className="mt-3">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => onResume(run.id)}
                    loading={resuming}
                  >
                    Retry {sentence(run.stages.at(-1)?.stage ?? 'stage')}
                  </Button>
                </div>
              ) : null}
              {run.handoff_reason ? (
                <p className="mt-3 text-xs text-mute">Handoff: {run.handoff_reason}</p>
              ) : null}
              <details className="mt-3 text-xs text-mute">
                <summary className="cursor-pointer select-none">
                  {run.events.length} lifecycle events
                </summary>
                <ol className="mt-2 space-y-1 border-l border-line pl-3 font-mono">
                  {run.events.map((event) => (
                    <li key={event.key}>
                      {event.kind}
                      {event.decision ? ` → ${event.decision}` : ''}
                      {event.reason ? ` · ${event.reason}` : ''}
                    </li>
                  ))}
                </ol>
              </details>
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </>
  );
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
  const dictation = useDictation((text) =>
    setBody((prev) => (prev.trim() ? `${prev}\n\n${text}` : text)),
  );
  const queryClient = useQueryClient();
  const submit = useMutation({
    mutationFn: (text: string) =>
      api.post(`/api/factory/features/${featureId}/comments`, {
        path: selection.file,
        line: selection.endLine,
        side: selection.side,
        body: text,
      }),
    // The comment bubble lands in the diff on click; the background
    // refetch swaps in the server row.
    onMutate: async (text) => {
      const me = queryClient.getQueryData<ApiMe>(['me']);
      const ctx = await applyOptimistic<ApiFeatureDetail>(
        queryClient,
        ['feature', featureId],
        (prev) => ({
          ...prev,
          comments: [
            ...prev.comments,
            {
              id: optimisticId(),
              path: selection.file,
              line: selection.endLine,
              side: selection.side,
              body: text,
              author: me?.login ?? '',
              status: 'open',
              created_at: optimisticNow(),
              fix_status: null,
            },
          ],
        }),
      );
      onDone();
      return ctx;
    },
    onSuccess: () => {
      toast.success('Comment added');
      void queryClient.invalidateQueries({ queryKey: ['feature', featureId] });
    },
    onError: (err, _v, ctx) => {
      ctx?.rollback();
      onApiError(err);
    },
  });

  return (
    <div className="m-2 rounded-md border border-line-2 border-l-2 border-l-accent bg-surface px-3 py-2">
      <div className="mb-1.5 text-xs text-mute">
        Comment on line {selection.endLine} — it'll be addressed the next time you hit Submit.
      </div>
      <Textarea
        autoFocus
        className="min-h-20"
        value={
          dictation.recording
            ? body.trim()
              ? `${body}\n\n${dictation.interim}`
              : dictation.interim
            : body
        }
        onChange={(e) => setBody(e.target.value)}
        disabled={dictation.recording}
        placeholder="What should change here?"
      />
      <div className="mt-2 flex gap-2">
        <MicButton dictation={dictation} />
        <Button
          size="sm"
          onClick={() => body.trim() && submit.mutate(body.trim())}
          disabled={!body.trim()}
          loading={submit.isPending}
        >
          {submit.isPending ? 'Adding…' : 'Add comment'}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            dictation.stop();
            onCancel();
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

function FileDiff({
  featureId,
  comments,
  prOpen,
  file,
  diffStyle,
}: {
  featureId: number;
  comments: ApiCockpitComment[];
  prOpen: boolean;
  file: CockpitFile;
  diffStyle: 'split' | 'unified';
}) {
  const [selection, setSelection] = useState<Selection | null>(null);

  const annotations = useMemo(() => {
    const list: DiffLineAnnotation<CockpitCommentMeta>[] = comments.map((c) => ({
      side: c.side === 'deletions' ? 'deletions' : 'additions',
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
  }, [comments, selection]);

  const onSelectionEnd = useCallback(
    (range: SelectedLineRange | null) => {
      if (!range || !Number.isFinite(range.start) || !Number.isFinite(range.end)) return;
      setSelection({
        file: file.filename,
        startLine: Math.min(range.start, range.end),
        endLine: Math.max(range.start, range.end),
        side: (range.endSide ?? range.side) === 'deletions' ? 'deletions' : 'additions',
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
    <Suspense fallback={<div className="h-64 animate-pulse bg-surface" />}>
      <CockpitPatchDiff
        patch={file.patch}
        annotations={annotations}
        renderAnnotation={(a: DiffLineAnnotation<CockpitCommentMeta>) =>
          a.metadata?.composer && selection ? (
            <Composer
              selection={selection}
              featureId={featureId}
              onDone={() => setSelection(null)}
              onCancel={() => setSelection(null)}
            />
          ) : a.metadata?.comment ? (
            <CommentCard comment={a.metadata.comment} />
          ) : null
        }
        diffStyle={diffStyle}
        prOpen={prOpen}
        onSelectionEnd={onSelectionEnd}
      />
    </Suspense>
  );
}

// One collapsible file card: sticky header (path, status, ±counts, comment
// count) over the diff surface.
const FileSection = memo(function FileSection({
  featureId,
  comments,
  prOpen,
  file,
  collapsed,
  commentCount,
  diffStyle,
  onToggle,
  sectionRef,
}: {
  featureId: number;
  comments: ApiCockpitComment[];
  prOpen: boolean;
  file: CockpitFile;
  collapsed: boolean;
  commentCount: number;
  diffStyle: 'split' | 'unified';
  onToggle: () => void;
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
      className="mt-3 scroll-mt-3 overflow-clip rounded-lg border border-line bg-surface [contain-intrinsic-size:auto_600px] [content-visibility:auto]"
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
          {file.additions > 0 ? <span className="text-go-bright">+{file.additions}</span> : null}{' '}
          {file.deletions > 0 ? <span className="text-danger">−{file.deletions}</span> : null}
        </span>
      </button>
      {collapsed ? null : (
        <FileDiff
          featureId={featureId}
          comments={comments}
          prOpen={prOpen}
          file={file}
          diffStyle={diffStyle}
        />
      )}
    </section>
  );
});

export default function FeaturePage() {
  const { featureId } = useParams({ from: '/shell/factory/features/$featureId' });
  const id = Number(featureId);
  const queryClient = useQueryClient();
  const { data: summary } = useSuspenseQuery(featureQuery(id));
  const diffQuery = useQuery({
    ...featureDiffQuery(id, summary.diff_version),
    enabled: summary.pr !== null,
  });
  // Read here too (deduped with ChatRail's own read) so the page knows
  // whether to mount the chat rail — a terminal PR with no history skips it.
  const chat = useQuery(chatQuery(id));
  // The shell's right-rail slot; the chat portals into it (see chat-rail.tsx).
  const railSlot = useContext(RailSlotContext);
  const data = useMemo<ApiFeatureDetail>(
    () => ({
      ...summary,
      files: diffQuery.data?.files ?? [],
      more_files: diffQuery.data?.more_files ?? 0,
    }),
    [summary, diffQuery.data],
  );
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['feature', id] });
  };

  // The merge ceremony plays only when the PR flips to merged while this
  // page is open (a click on Merge, or auto-merge landing mid-poll) — a
  // page that loads already-merged shows the stamp and seal at rest.
  const prevPrState = useRef(data.pr?.state);
  const [justMerged, setJustMerged] = useState(false);
  useEffect(() => {
    const state = data.pr?.state;
    if (prevPrState.current && prevPrState.current !== 'merged' && state === 'merged') {
      setJustMerged(true);
    }
    prevPrState.current = state;
  }, [data.pr?.state]);

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
  const sectionEls = useRef(new Map<string, HTMLElement>());

  const commentsByFile = useMemo(() => {
    const comments = new Map<string, ApiCockpitComment[]>();
    for (const comment of data.comments) {
      const existing = comments.get(comment.path) ?? [];
      existing.push(comment);
      comments.set(comment.path, existing);
    }
    return comments;
  }, [data.comments]);
  const commentCounts = useMemo(
    () => new Map([...commentsByFile].map(([path, comments]) => [path, comments.length])),
    [commentsByFile],
  );

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
      api.post<{ ok: boolean; conflict?: boolean; resolving?: boolean; queued?: boolean }>(
        `/api/factory/features/${id}/merge`,
      ),
    onSuccess: (result) => {
      toast.success(
        result.resolving
          ? 'Merge conflict detected — auto-resolving…'
          : result.queued
            ? 'Merge started — this page updates when it lands'
            : 'Pull request merged',
      );
      refresh();
    },
    onError: onApiError,
  });
  const resumeStage = useMutation({
    mutationFn: (runId: number) =>
      api.post(`/api/factory/features/${id}/lifecycle/${runId}/resume`),
    onSuccess: () => {
      toast.success('Stage retried — it runs again on the same delivery');
      refresh();
    },
    onError: onApiError,
  });
  const rereview = useMutation({
    mutationFn: () => api.post(`/api/factory/features/${id}/review`),
    onSuccess: () => {
      toast.success('Review dispatched — the verdict lands here when it completes');
      refresh();
    },
    onError: onApiError,
  });
  const abandon = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; branchDeleted?: boolean }>(`/api/factory/features/${id}/abandon`),
    onSuccess: (result) => {
      toast.success(
        result.branchDeleted === false
          ? 'Pull request closed (branch could not be deleted — check GitHub)'
          : 'Pull request closed and branch deleted',
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
              <p
                className={cn(
                  'mt-2 text-[0.85rem]',
                  retryQueued(data.feature.error) ? 'text-mute' : 'text-danger',
                )}
              >
                {data.feature.error}
              </p>
            ) : null}
            <div className="mt-4">
              <Button
                onClick={() => retryGeneration.mutate()}
                loading={retryGeneration.isPending}
                disabled={retryQueued(data.feature.error)}
              >
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
  // An open PR always gets the chat rail (the agent is writable); a terminal
  // PR gets it only when there's history worth showing.
  const showChat = prState === 'open' || (chat.data?.messages.length ?? 0) > 0;
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
    <div className="animate-rise space-y-4">
      {/* Identity: who/what this PR is, its size, and any external checks. */}
      <Panel>
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Serial n={data.feature.id} />
              {prState === 'merged' ? (
                <Stamp tone="ok" className={justMerged ? 'stamp-ceremony' : undefined}>
                  MERGED
                </Stamp>
              ) : null}
              {prState === 'closed' ? <Stamp tone="red">ABANDONED</Stamp> : null}
            </div>
            <h1 className="mt-2 text-lg leading-snug font-medium break-words sm:text-xl">
              {data.feature.title}
            </h1>
            <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-mute sm:text-[0.85rem]">
              <span className="truncate font-mono">{data.repo}</span>
              <span>·</span>
              {data.pr.html_url ? (
                <a
                  href={data.pr.html_url}
                  target="_blank"
                  rel="noopener"
                  className="font-mono text-accent-bright hover:underline"
                >
                  PR #{data.feature.pr_number}
                </a>
              ) : (
                <span className="font-mono text-ink-dim">
                  CR #{data.cr_number ?? data.feature.pr_number}
                </span>
              )}
              <span>·</span>
              <span>
                {data.pr.changed_files} files{' '}
                <span className="text-go-bright">+{data.pr.additions}</span>{' '}
                <span className="text-danger">−{data.pr.deletions}</span>
              </span>
            </p>
          </div>
          {data.checks.length > 0 ? (
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              {data.checks.map((check) => (
                <Pill
                  key={check.name}
                  tone={
                    check.status === 'passed'
                      ? 'on'
                      : check.status === 'running'
                        ? 'running'
                        : check.status === 'failed' || check.status === 'error'
                          ? 'red'
                          : 'neutral'
                  }
                >
                  {check.name}: {check.status}
                </Pill>
              ))}
            </div>
          ) : null}
        </div>
      </Panel>

      {data.feature.criteria_conflict ? (
        <CriteriaConflictCard
          // Remount when the underlying text changes: the draft is captured
          // at mount, and a stale page must never post yesterday's contract.
          key={(data.feature.proposed_criteria ?? data.criteria.map((c) => c.text)).join('\u0000')}
          featureId={data.feature.id}
          criteria={data.criteria.map((criterion) => criterion.text)}
          proposed={data.feature.proposed_criteria}
        />
      ) : null}
      {/* Control row: the go/no-go pipeline and its actions. Merge is the
          primary CTA, a guarded control that reads as armed only when green.
          The agent chat lives in the shell's right rail (below), not here. */}
      <Panel className="flex min-w-0 flex-col">
        <BlockLabel className="mb-3">Pipeline</BlockLabel>
        <GoNoGoBoard data={data} />
        {prState === 'open' || pendingCount > 0 || batchRunning ? (
          <div className="mt-4 flex flex-col gap-2 border-t border-line/60 pt-4 sm:flex-row sm:flex-wrap sm:items-center lg:mt-auto">
            {prState === 'open' ? (
              <ConfirmButton
                className="guarded relative w-full font-mono text-[11px] font-bold tracking-[0.18em] uppercase sm:w-auto"
                title="Merge pull request?"
                description={
                  data.provider === 'artifacts'
                    ? `This merges CR #${data.cr_number ?? data.feature.pr_number} into ${data.repo} on turbodiff.`
                    : `This merges PR #${data.feature.pr_number} into ${data.repo} on GitHub.`
                }
                confirmLabel="Merge"
                onConfirm={() => merge.mutate()}
                busy={merge.isPending}
              >
                Merge
              </ConfirmButton>
            ) : null}
            {prState === 'open' && data.provider === 'artifacts' ? (
              <Button
                variant="secondary"
                className="w-full sm:w-auto"
                loading={rereview.isPending}
                onClick={() => rereview.mutate()}
              >
                {data.reviews.length > 0 || data.checks.some((ch) => ch.name === 'review')
                  ? 'Re-run review'
                  : 'Run review'}
              </Button>
            ) : null}
            {prState === 'open' ? (
              <ConfirmButton
                className="w-full sm:w-auto"
                variant="danger"
                title="Abandon this pull request?"
                description={`This closes PR #${data.feature.pr_number} on ${data.repo} without merging and deletes its branch. This cannot be undone.`}
                confirmLabel="Abandon"
                onConfirm={() => abandon.mutate()}
                busy={abandon.isPending}
              >
                Abandon
              </ConfirmButton>
            ) : null}
            {pendingCount > 0 || batchRunning ? (
              <Button
                variant="secondary"
                className="w-full sm:ml-auto sm:w-auto"
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
      </Panel>

      {/* Full-height agent chat beside the page — it rides in the shell's
          rail slot so it scrolls independently of the diff. */}
      {showChat && railSlot
        ? createPortal(
            <Suspense fallback={<RailPlaceholder />}>
              <ChatRail
                featureId={data.feature.id}
                canWrite={prState === 'open'}
                prState={prState}
                prNumber={data.feature.pr_number}
                repo={data.repo}
                provider={data.provider}
                activeFile={activeFile}
                checksFailing={data.checks.some(
                  (check) => check.status === 'failed' || check.status === 'error',
                )}
              />
            </Suspense>,
            railSlot,
          )
        : null}

      {/* The paper the work earns: sealed once the PR merges. */}
      {data.certificate_url ? (
        <a
          href={data.certificate_url}
          target="_blank"
          rel="noopener"
          className="block max-w-xl hover:opacity-90"
        >
          <CertStrip sealed={prState === 'merged'} ceremony={justMerged}>
            BUILD CERTIFICATE №{String(data.feature.id).padStart(4, '0')} —{' '}
            {prState === 'merged'
              ? 'sealed · view →'
              : 'issues when this PR is verified and merged'}
          </CertStrip>
        </a>
      ) : null}

      {/* Evidence: criteria fills the width in two columns; the rest are
          collapsible full-width sections. */}
      {data.demo ? (
        <div>
          <SectionHeading>Demo</SectionHeading>
          <video
            className="w-full max-w-3xl rounded-lg border border-line-2 bg-black shadow-sticker-lg"
            controls
            autoPlay
            muted
            loop
            playsInline
            src={data.demo.url}
          />
          {data.demo.caption ? (
            <p className="mt-2 max-w-3xl text-xs leading-relaxed text-mute">{data.demo.caption}</p>
          ) : null}
        </div>
      ) : null}

      {data.criteria.length > 0 ? (
        <div>
          <SectionHeading>Acceptance criteria</SectionHeading>
          <Accordion type="single" collapsible defaultValue="criteria">
            <AccordionItem value="criteria">
              <AccordionTrigger
                aside={
                  <span className="font-mono text-xs tracking-[0.1em] text-mute uppercase tabular-nums">
                    {data.criteria.filter((c) => c.verdict === 'pass').length}/
                    {data.criteria.length} proven
                  </span>
                }
              >
                {data.criteria.length} criteri{data.criteria.length === 1 ? 'on' : 'a'}
              </AccordionTrigger>
              <AccordionContent>
                <ul className="grid gap-x-8 gap-y-4 pt-1 md:grid-cols-2">
                  {data.criteria.map((crit, i) => (
                    <li key={i} className="flex gap-2.5 text-[0.85rem] leading-relaxed">
                      <span className="mt-0.5 shrink-0">
                        <VerdictMark verdict={crit.verdict} />
                      </span>
                      <div className="min-w-0">
                        {crit.text}
                        {crit.note ? (
                          <div className="mt-0.5 text-xs text-mute">{crit.note}</div>
                        ) : null}
                        {crit.screenshot_url ? (
                          <div className="mt-1.5">
                            <img
                              src={crit.screenshot_url}
                              alt=""
                              className="max-h-40 rounded-lg border border-line-2 bg-black shadow-sticker-lg"
                            />
                          </div>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>
      ) : null}

      {data.reviews.length > 0 ? (
        <div>
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
        </div>
      ) : null}

      {data.plan ? (
        <div>
          <SectionHeading>Plan</SectionHeading>
          <Accordion type="single" collapsible>
            <AccordionItem value="plan">
              <AccordionTrigger>Implementation plan (approved)</AccordionTrigger>
              <AccordionContent>
                <Markdown>{data.plan}</Markdown>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>
      ) : null}

      <LifecycleHistory
        runs={data.lifecycle_runs}
        onResume={(runId) => resumeStage.mutate(runId)}
        resuming={resumeStage.isPending}
      />
      <AgentRunLog runs={data.runs} />

      {/* Review workspace: an always-visible file tree beside the diff, so the
          tree lines up with the code it navigates (not the evidence above). */}
      <section>
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
                      'cursor-pointer px-2.5 py-1 text-xs transition-colors max-sm:px-3.5 max-sm:py-2',
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

        {/* Small screens: a jump list instead of the side rail. */}
        <Accordion type="single" collapsible className="mt-3 lg:hidden">
          <AccordionItem value="files">
            <AccordionTrigger className="text-xs text-mute">
              {data.files.length} file{data.files.length === 1 ? '' : 's'} changed — jump to a file
            </AccordionTrigger>
            <AccordionContent>{fileTree}</AccordionContent>
          </AccordionItem>
        </Accordion>

        <div className="mt-3 lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] lg:items-start lg:gap-6">
          {/* Always-visible sticky file tree (desktop). */}
          <aside className="hidden lg:sticky lg:top-4 lg:block lg:max-h-[calc(100dvh-2rem)] lg:overflow-y-auto lg:pb-2">
            <div className="mb-2 flex items-baseline justify-between gap-2 px-1.5">
              <span className="font-mono text-[10px] font-medium tracking-[0.16em] text-mute uppercase">
                Files
              </span>
              <span className="text-xs text-mute tabular-nums">
                {data.files.length} · <span className="text-go-bright">+{totalAdditions}</span>{' '}
                <span className="text-danger">−{totalDeletions}</span>
              </span>
            </div>
            {fileTree}
          </aside>

          <div className="min-w-0">
            {diffQuery.isPending ? (
              <div
                className="h-80 animate-pulse rounded-lg border border-line bg-surface"
                role="status"
                aria-label="Loading diff"
              />
            ) : null}
            {diffQuery.isError ? (
              <Card>
                <p className="text-sm text-danger">The diff could not be loaded.</p>
                <Button
                  variant="secondary"
                  size="sm"
                  className="mt-3"
                  onClick={() => void diffQuery.refetch()}
                >
                  Retry
                </Button>
              </Card>
            ) : null}
            {data.files.length > 0 ? (
              <Suspense fallback={<div className="h-80 animate-pulse bg-surface" />}>
                <CockpitDiffWorkspace>
                  {data.files.map((f) => (
                    <FileSection
                      key={f.filename}
                      featureId={data.feature.id}
                      comments={commentsByFile.get(f.filename) ?? []}
                      prOpen={prState === 'open'}
                      file={f}
                      diffStyle={diffStyle}
                      collapsed={collapsed.has(f.filename)}
                      commentCount={commentsByFile.get(f.filename)?.length ?? 0}
                      onToggle={() => toggleFile(f.filename)}
                      sectionRef={(el) => {
                        if (el) sectionEls.current.set(f.filename, el);
                        else sectionEls.current.delete(f.filename);
                      }}
                    />
                  ))}
                </CockpitDiffWorkspace>
              </Suspense>
            ) : null}
            {data.more_files > 0 ? (
              <Muted className="mt-3 block">
                …and {data.more_files} more files — see the PR on GitHub.
              </Muted>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}
