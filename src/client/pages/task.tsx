import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Bell,
  MessageSquarePlus,
  Paperclip,
  X,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import type { ApiBoard, ApiPlan, ApiTaskDetail } from '../../shared/api-types.ts';
import { RUNNER_MODELS } from '../../shared/runner-models.ts';
import { api, ApiError } from '../lib/api.ts';
import { useDictation } from '../lib/dictation.ts';
import { ago } from '../lib/format.ts';
import { applyOptimistic } from '../lib/optimistic.ts';
import { pushSupported, subscribeToPush } from '../lib/push.ts';
import { GENERATION_STOPPED, meQuery, retryQueued, taskQuery } from '../lib/queries.ts';
import { taskColumn, taskStages, taskState } from '../lib/task-state.ts';
import { cn } from '../lib/utils.ts';
import { AgentRunLog } from '../components/agent-run-log.tsx';
import { ConfirmButton } from '../components/confirm-button.tsx';
import { Serial, StageLights, Stamp } from '../components/identity.tsx';
import { Markdown } from '../components/markdown.tsx';
import { MicButton } from '../components/mic-button.tsx';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '../components/ui/accordion.tsx';
import { QuestionsCarousel } from '../components/questions-carousel.tsx';
import { Button, buttonVariants } from '../components/ui/button.tsx';
import { Select, Textarea } from '../components/ui/input.tsx';
import { BlockLabel, Panel } from '../components/ui/panel.tsx';
import { Pill } from '../components/ui/pill.tsx';

function onApiError<T>(err: T) {
  toast.error(err instanceof ApiError ? err.message : 'Request failed');
}

// Set once regardless of the answer — "contextual" means timing (the first
// task that hits a human-blocking state while open), not "ask every task".
const PUSH_PROMPTED_KEY = 'turbodiff:push-prompted';

// Compact rail affordance: an icon-only bell (tooltip'd) rather than a banner
// that competes with the task's actual content. An explicit click — not an
// auto Notification.requestPermission() — because browsers only honor the
// prompt from a direct gesture, and an unprompted call burns the one shot.
function NotificationsRailButton({ vapidPublicKey }: { vapidPublicKey: string }) {
  const [enabling, setEnabling] = useState(false);
  if (!pushSupported() || !('Notification' in window) || Notification.permission !== 'default') {
    return null;
  }
  const enable = async () => {
    setEnabling(true);
    try {
      const granted = await subscribeToPush(vapidPublicKey);
      if (granted) toast.success('Notifications enabled');
      else toast.error('Notification permission was not granted');
    } catch (err) {
      onApiError(err);
    } finally {
      setEnabling(false);
      localStorage.setItem(PUSH_PROMPTED_KEY, '1');
    }
  };
  return (
    <Button variant="secondary" className="w-full" onClick={enable} loading={enabling}>
      {enabling ? null : <Bell className="size-3.5" aria-hidden />}
      Get notified
    </Button>
  );
}

function AnswersForm({ task, onDone }: { task: ApiPlan; onDone: () => void }) {
  const submit = useMutation({
    mutationFn: (answers: string[]) =>
      api.post(`/api/factory/plans/${task.id}/answers`, { answers }),
    onSuccess: () => {
      toast.success('Answers submitted — refining the plan');
      onDone();
    },
    onError: onApiError,
  });
  return (
    <QuestionsCarousel
      questions={task.questions}
      onSubmit={(answers) => submit.mutate(answers)}
      submitting={submit.isPending}
    />
  );
}

export function TaskPage() {
  const { taskId } = useParams({ from: '/shell/tasks/$taskId' });
  const id = Number(taskId);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: task } = useSuspenseQuery(taskQuery(id));
  const { data: me } = useSuspenseQuery(meQuery);
  const state = taskState(task);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['task', id] });
    void queryClient.invalidateQueries({ queryKey: ['board'] });
  };

  const approve = useMutation({
    mutationFn: () => api.post(`/api/factory/plans/${task.id}/approve`),
    // The page flips to the approved state on click; the refetch reconciles.
    onMutate: () =>
      applyOptimistic<ApiTaskDetail>(queryClient, ['task', id], (prev) => ({
        ...prev,
        status: 'approved',
      })),
    onSuccess: () => {
      toast.success('Plan approved — generation queued');
      refresh();
    },
    onError: (err, _v, ctx) => {
      ctx?.rollback();
      onApiError(err);
    },
  });
  // Each repo's feature retries independently — the mutation takes the
  // feature id so the correct button can show its own loading state.
  const retry = useMutation({
    mutationFn: (featureId: number) => api.post(`/api/factory/features/${featureId}/retry`),
    onSuccess: () => {
      toast.success('Generation retried');
      refresh();
    },
    onError: onApiError,
  });
  const retryPlan = useMutation({
    mutationFn: () => api.post(`/api/factory/plans/${task.id}/retry`),
    onSuccess: () => {
      toast.success('Planning restarted');
      refresh();
    },
    onError: onApiError,
  });
  const setModel = useMutation({
    mutationFn: (model: string) => api.post(`/api/tasks/${task.id}/model`, { model }),
    // The select reflects the choice immediately instead of snapping back
    // until the refetch lands.
    onMutate: (model) =>
      applyOptimistic<ApiTaskDetail>(queryClient, ['task', id], (prev) => ({ ...prev, model })),
    onSuccess: () => {
      toast.success('Model updated — applies to future runs on this task');
      refresh();
    },
    onError: (err, _v, ctx) => {
      ctx?.rollback();
      onApiError(err);
    },
  });
  const archive = useMutation({
    mutationFn: (archived: boolean) => api.post(`/api/tasks/${task.id}/archive`, { archived }),
    // Archiving leaves for the board immediately, with the card already
    // gone; the background refetch reconciles (or the rollback restores it).
    onMutate: (archived) => {
      if (!archived) return undefined;
      void navigate({ to: '/' });
      return applyOptimistic<ApiBoard>(queryClient, ['board'], (prev) => ({
        ...prev,
        tasks: prev.tasks.filter((t) => t.id !== task.id),
      }));
    },
    onSuccess: (_d, archived) => {
      toast.success(archived ? 'Task archived' : 'Task restored to the board');
      refresh();
    },
    onError: (err, _v, ctx) => {
      ctx?.rollback();
      onApiError(err);
    },
  });

  // Plan review feedback: select text in the plan, comment via the popover,
  // then submit the whole batch for a revise run.
  const planRef = useRef<HTMLDivElement>(null);
  const [popover, setPopover] = useState<{ x: number; y: number; snippet: string } | null>(null);
  const [note, setNote] = useState('');
  const dictation = useDictation((text) =>
    setNote((prev) => (prev.trim() ? `${prev}\n\n${text}` : text)),
  );
  const [comments, setComments] = useState<{ snippet: string; comment: string }[]>([]);
  const sendFeedback = useMutation({
    mutationFn: () => api.post(`/api/factory/plans/${task.id}/feedback`, { comments }),
    onSuccess: () => {
      setComments([]);
      toast.success('Feedback sent — revising the plan');
      refresh();
    },
    onError: onApiError,
  });
  const onPlanSelect = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !planRef.current?.contains(sel.anchorNode)) return;
    const text = sel.toString().trim();
    if (!text) return;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    setPopover({
      x: Math.min(Math.max(rect.left + rect.width / 2, 150), window.innerWidth - 150),
      y: Math.min(rect.bottom + 8, window.innerHeight - 180),
      snippet: text.slice(0, 300),
    });
    setNote('');
  };
  const addComment = () => {
    if (!popover || !note.trim()) return;
    setComments((prev) => [...prev, { snippet: popover.snippet, comment: note.trim() }]);
    setPopover(null);
    window.getSelection()?.removeAllRanges();
    dictation.stop();
  };

  const done = taskColumn(task) === 'done';
  const showNotify = task.status === 'awaiting_answers' || task.status === 'plan_ready';
  return (
    <div className="animate-rise">
      <Link
        to="/"
        className="inline-flex items-center gap-1.5 py-1 text-xs text-mute hover:text-ink"
      >
        <ArrowLeft className="size-3.5" aria-hidden /> Board
      </Link>

      {/* Summary header: identity, status, and the stage spine in one panel. */}
      <Panel className="mt-2">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2.5">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Serial n={task.id} />
              {done ? <Stamp tone="ok">MERGED</Stamp> : null}
            </div>
            <h1 className="mt-2 text-lg leading-snug font-medium break-words sm:text-xl">
              {task.title}
            </h1>
            <p className="mt-2 text-xs text-mute sm:text-[0.85rem]">
              <span className="font-mono">
                {task.repos.map((r) => `${r.owner}/${r.name}`).join(', ')}
              </span>
              {' · '}
              {ago(task.created_at)}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Pill tone={state.tone} className="max-w-full">
              <span className="min-w-0 truncate">{state.label}</span>
            </Pill>
            {task.repos
              .filter((r) => r.verification)
              .map((r) => {
                const label = `${task.repos.length > 1 ? `${r.owner}/${r.name} ` : ''}Verify: ${
                  r.verification!.status
                }${r.verification!.status === 'failed' ? ` (${r.verification!.failed} unmet)` : ''}`;
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
            {task.archived ? <Pill>Archived</Pill> : null}
          </div>
        </div>
        {done ? null : <StageLights stages={taskStages(task)} className="mt-4 max-w-md" />}
        {state.hint ? (
          <p className="mt-3 border-t border-line/60 pt-3 text-xs text-mute/80">{state.hint}</p>
        ) : null}
      </Panel>

      {/* Workspace: the state's content (main) beside a constant controls rail. */}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_19rem] lg:items-start">
        <div className="min-w-0 space-y-6">
          {task.status === 'failed' ? (
            <section>
              <BlockLabel className="mb-2">Planning failed</BlockLabel>
              <Panel className="border-danger/30">
                <p className="text-[0.85rem] leading-relaxed text-danger">
                  {task.error ?? 'Planning didn’t complete.'}
                </p>
                <Button
                  className="mt-4"
                  onClick={() => retryPlan.mutate()}
                  loading={retryPlan.isPending}
                >
                  Retry planning
                </Button>
              </Panel>
            </section>
          ) : null}

          {task.status === 'awaiting_answers' && task.questions.length > 0 ? (
            <section>
              <BlockLabel className="mb-2">Next · answer to continue</BlockLabel>
              <Panel>
                <AnswersForm task={task} onDone={refresh} />
              </Panel>
            </section>
          ) : null}

          {task.status === 'plan_ready' ? (
            <>
              <section>
                <BlockLabel className="mb-2">Implementation plan</BlockLabel>
                <Panel>
                  <p className="mb-3 flex items-center gap-1.5 border-b border-line/50 pb-2.5 text-[11px] text-mute/70">
                    <MessageSquarePlus className="size-3 shrink-0" aria-hidden />
                    Select any text in the plan to leave a comment.
                  </p>
                  <div
                    ref={planRef}
                    onMouseUp={onPlanSelect}
                    onTouchEnd={onPlanSelect}
                    className="max-w-3xl cursor-text selection:bg-accent/30"
                  >
                    <Markdown>{task.plan ?? ''}</Markdown>
                  </div>
                </Panel>
              </section>

              {task.acceptance.length > 0 ? (
                <section>
                  <div className="mb-2 flex items-baseline justify-between gap-2">
                    <BlockLabel>Acceptance criteria</BlockLabel>
                    <span className="text-xs text-mute tabular-nums">
                      {task.acceptance.length} to verify
                    </span>
                  </div>
                  <ol className="divide-y divide-line/40 overflow-hidden rounded-xl border border-line/60 bg-raised/30">
                    {task.acceptance.map((a, i) => (
                      <li
                        key={i}
                        className="flex items-baseline gap-3 px-3.5 py-2.5 text-[0.85rem] leading-relaxed"
                      >
                        <span className="shrink-0 font-mono text-[0.68rem] tracking-wider text-accent-bright/80">
                          AC-{String(i + 1).padStart(2, '0')}
                        </span>
                        <span className="min-w-0">{a}</span>
                      </li>
                    ))}
                  </ol>
                  <p className="mt-2 text-xs text-mute/70">
                    Each criterion is checked against the generated PR during verification.
                  </p>
                </section>
              ) : null}

              {comments.length > 0 ? (
                <section>
                  <BlockLabel className="mb-2">Your feedback</BlockLabel>
                  <div className="flex flex-col gap-2">
                    {comments.map((f, i) => (
                      <div key={i} className="rounded-xl bg-raised/50 p-3">
                        <div className="flex items-start justify-between gap-2">
                          <p className="line-clamp-2 border-l-2 border-line-2 pl-2 text-xs text-mute italic">
                            {f.snippet}
                          </p>
                          <button
                            type="button"
                            aria-label="Remove comment"
                            className="cursor-pointer p-0.5 text-mute hover:text-danger max-sm:p-2"
                            onClick={() => setComments((prev) => prev.filter((_, j) => j !== i))}
                          >
                            <X className="size-3.5" aria-hidden />
                          </button>
                        </div>
                        <p className="mt-1.5 text-[0.85rem]">{f.comment}</p>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}

              <div className="flex flex-col gap-2 sm:flex-row">
                <Button onClick={() => approve.mutate()} loading={approve.isPending}>
                  Approve &amp; generate
                </Button>
                {comments.length > 0 ? (
                  <Button
                    variant="secondary"
                    onClick={() => sendFeedback.mutate()}
                    loading={sendFeedback.isPending}
                  >
                    Send feedback ({comments.length}) &amp; revise plan
                  </Button>
                ) : null}
              </div>
            </>
          ) : null}

          {task.status === 'approved' ? (
            <section>
              <BlockLabel className="mb-2">Generated changes</BlockLabel>
              <div className="flex flex-col gap-3">
                {task.repos.map((r) => {
                  const abandoned = r.feature_status === 'abandoned';
                  const stopped = !r.pr_number && GENERATION_STOPPED.has(r.feature_status ?? '');
                  const tone =
                    stopped || abandoned
                      ? 'red'
                      : r.feature_status === 'merged' || r.pr_number
                        ? 'on'
                        : 'running';
                  const label = stopped
                    ? 'Generation stopped'
                    : abandoned
                      ? 'Abandoned'
                      : r.feature_status === 'merged'
                        ? 'Merged'
                        : r.pr_number
                          ? `PR #${r.pr_number}`
                          : 'Generating';
                  const featureId = r.feature_id;
                  return (
                    <div
                      key={r.repository_id}
                      className="rounded-xl border border-line bg-surface/60 p-4"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[0.85rem] font-medium">
                          {r.owner}/{r.name}
                        </span>
                        <Pill tone={tone}>{label}</Pill>
                      </div>
                      {stopped && r.feature_error ? (
                        <p
                          className={cn(
                            'mt-2 text-[0.85rem]',
                            retryQueued(r.feature_error) ? 'text-mute' : 'text-danger',
                          )}
                        >
                          {r.feature_error}
                        </p>
                      ) : null}
                      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                        {stopped && featureId !== null ? (
                          <Button
                            size="sm"
                            onClick={() => retry.mutate(featureId)}
                            loading={retry.isPending && retry.variables === r.feature_id}
                            disabled={retryQueued(r.feature_error)}
                          >
                            Retry generation
                          </Button>
                        ) : null}
                        {r.pr_number && r.feature_id !== null ? (
                          <Link
                            to="/factory/features/$featureId"
                            params={{ featureId: String(r.feature_id) }}
                            className={cn(
                              buttonVariants({ variant: 'default', size: 'sm' }),
                              'w-full sm:w-auto',
                            )}
                          >
                            Open in cockpit
                          </Link>
                        ) : null}
                        {r.pr_number && r.provider !== 'artifacts' ? (
                          <a
                            href={`https://github.com/${r.owner}/${r.name}/pull/${r.pr_number}`}
                            target="_blank"
                            rel="noopener"
                            className={cn(
                              buttonVariants({ variant: 'secondary', size: 'sm' }),
                              'w-full sm:w-auto',
                            )}
                          >
                            PR #{r.pr_number} on GitHub
                          </a>
                        ) : null}
                        {r.pr_number && r.provider === 'artifacts' ? (
                          <span className="inline-flex items-center px-2 text-xs text-mute">
                            CR #{r.pr_number} · hosted on turbodiff
                          </span>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ) : null}

          {task.plan && task.status === 'approved' ? (
            <section>
              <BlockLabel className="mb-2">Implementation plan</BlockLabel>
              <Accordion type="single" collapsible>
                <AccordionItem value="plan">
                  <AccordionTrigger>Implementation plan (approved)</AccordionTrigger>
                  <AccordionContent>
                    <Markdown>{task.plan}</Markdown>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </section>
          ) : null}
        </div>

        {/* Rail: settings and task actions, constant across every state. Labels
            sit above each control — the same rhythm as the main column — so the
            first control (Model) lines up with the first content card. */}
        <aside className="space-y-5 lg:sticky lg:top-6">
          <div>
            <BlockLabel className="mb-2">Model</BlockLabel>
            <Select
              id="task-model"
              value={task.model}
              onChange={(e) => setModel.mutate(e.target.value)}
              disabled={setModel.isPending}
              className="w-full text-xs"
            >
              {RUNNER_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </Select>
          </div>

          {task.attachments.length > 0 ? (
            <div>
              <BlockLabel className="mb-2">Attachments</BlockLabel>
              <div className="flex flex-wrap gap-1.5">
                {task.attachments.map((a, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1 rounded-full bg-raised/70 px-2.5 py-0.5 text-xs text-mute"
                  >
                    <Paperclip className="size-3" aria-hidden />
                    <span className="max-w-40 truncate">{a.name}</span>
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          <div>
            <BlockLabel className="mb-2">Task</BlockLabel>
            <div className="flex flex-col gap-1.5">
              {showNotify ? <NotificationsRailButton vapidPublicKey={me.vapid_public_key} /> : null}
              {task.archived ? (
                <Button
                  variant="secondary"
                  className="w-full"
                  onClick={() => archive.mutate(false)}
                  loading={archive.isPending}
                >
                  <ArchiveRestore className="size-3.5" aria-hidden /> Restore to board
                </Button>
              ) : (
                <ConfirmButton
                  variant="secondary"
                  className="w-full"
                  title="Archive this task?"
                  description="Started tasks are never deleted — archiving hides it from the board. The plan, PR, and history stay, and you can restore it from this page."
                  confirmLabel="Archive"
                  onConfirm={() => archive.mutate(true)}
                  busy={archive.isPending}
                >
                  <Archive className="size-3.5" aria-hidden /> Archive task
                </ConfirmButton>
              )}
            </div>
          </div>
        </aside>
      </div>

      {/* Session logs: full-width history below the workspace. */}
      <div className="mt-2">
        <AgentRunLog runs={task.runs} />
      </div>

      {/* Plan-review comment popover — fixed, so it lives at the tree root. */}
      {popover ? (
        <div
          className="fixed z-50 w-72 -translate-x-1/2 rounded-lg border border-line-2 bg-surface p-3 shadow-sticker-lg"
          style={{ left: popover.x, top: popover.y }}
        >
          <p className="line-clamp-2 text-xs text-mute italic">{popover.snippet}</p>
          <Textarea
            autoFocus
            value={
              dictation.recording
                ? note.trim()
                  ? `${note}\n\n${dictation.interim}`
                  : dictation.interim
                : note
            }
            onChange={(e) => setNote(e.target.value)}
            disabled={dictation.recording}
            placeholder="What should change here?"
            className="mt-2 min-h-16"
          />
          <div className="mt-2 flex justify-end gap-2">
            <MicButton dictation={dictation} />
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                dictation.stop();
                setPopover(null);
              }}
            >
              Cancel
            </Button>
            <Button size="sm" onClick={addComment} disabled={!note.trim()}>
              Add comment
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
