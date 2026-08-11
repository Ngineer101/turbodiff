import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { ArrowLeft, MessageSquarePlus, Paperclip, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import type { ApiPlan } from '../../shared/api-types.ts';
import { api, ApiError } from '../lib/api.ts';
import { ago } from '../lib/format.ts';
import { GENERATION_STOPPED, taskQuery } from '../lib/queries.ts';
import { taskState } from '../lib/task-state.ts';
import { cn } from '../lib/utils.ts';
import { ConfirmButton } from '../components/confirm-button.tsx';
import { Markdown } from '../components/markdown.tsx';
import { QuestionsCarousel } from '../components/questions-carousel.tsx';
import { SectionHeading } from '../components/section.tsx';
import { Button, buttonVariants } from '../components/ui/button.tsx';
import { Textarea } from '../components/ui/input.tsx';
import { Pill } from '../components/ui/pill.tsx';

function onApiError(err: unknown) {
  toast.error(err instanceof ApiError ? err.message : 'request failed');
}

function AnswersForm({ task, onDone }: { task: ApiPlan; onDone: () => void }) {
  const submit = useMutation({
    mutationFn: (answers: string[]) =>
      api.post(`/api/factory/plans/${task.id}/answers`, { answers }),
    onSuccess: () => {
      toast.success('answers submitted — refining the plan');
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
  const { taskId } = useParams({ from: '/tasks/$taskId' });
  const id = Number(taskId);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: task } = useSuspenseQuery(taskQuery(id));
  const state = taskState(task);
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['task', id] });
    queryClient.invalidateQueries({ queryKey: ['board'] });
  };

  const approve = useMutation({
    mutationFn: () => api.post(`/api/factory/plans/${task.id}/approve`),
    onSuccess: () => {
      toast.success('plan approved — generation queued');
      refresh();
    },
    onError: onApiError,
  });
  // Each repo's feature retries independently — the mutation takes the
  // feature id so the correct button can show its own loading state.
  const retry = useMutation({
    mutationFn: (featureId: number) => api.post(`/api/factory/features/${featureId}/retry`),
    onSuccess: () => {
      toast.success('generation retried');
      refresh();
    },
    onError: onApiError,
  });
  const archive = useMutation({
    mutationFn: (archived: boolean) => api.post(`/api/tasks/${task.id}/archive`, { archived }),
    onSuccess: (_d, archived) => {
      toast.success(archived ? 'task archived' : 'task restored to the board');
      refresh();
      if (archived) navigate({ to: '/' });
    },
    onError: onApiError,
  });

  // Plan review feedback: select text in the plan, comment via the popover,
  // then submit the whole batch for a revise run.
  const planRef = useRef<HTMLDivElement>(null);
  const [popover, setPopover] = useState<{ x: number; y: number; snippet: string } | null>(null);
  const [note, setNote] = useState('');
  const [comments, setComments] = useState<{ snippet: string; comment: string }[]>([]);
  const sendFeedback = useMutation({
    mutationFn: () => api.post(`/api/factory/plans/${task.id}/feedback`, { comments }),
    onSuccess: () => {
      setComments([]);
      toast.success('feedback sent — revising the plan');
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
  };

  return (
    <>
      <Link
        to="/"
        className="inline-flex items-center gap-1.5 py-1 text-xs text-mute hover:text-ink"
      >
        <ArrowLeft className="size-3.5" aria-hidden /> board
      </Link>
      <h1 className="mt-2 text-base leading-snug font-medium break-words sm:text-xl">
        {task.title}
      </h1>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Pill tone={state.tone}>{state.label}</Pill>
        {task.repos
          .filter((r) => r.verification)
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
              {task.repos.length > 1 ? `${r.owner}/${r.name} ` : ''}verify: {r.verification!.status}
              {r.verification!.status === 'failed' ? ` (${r.verification!.failed} unmet)` : ''}
            </Pill>
          ))}
        {task.archived ? <Pill>archived</Pill> : null}
      </div>
      <p className="mt-2.5 text-xs text-mute sm:text-[0.85rem]">
        <span className="font-mono">
          {task.repos.map((r) => `${r.owner}/${r.name}`).join(', ')}
        </span>{' '}
        · {ago(task.created_at)}
      </p>
      {task.attachments.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {task.attachments.map((a, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1 rounded-full bg-raised/70 px-2.5 py-0.5 text-xs text-mute"
            >
              <Paperclip className="size-3" aria-hidden />
              <span className="max-w-44 truncate">{a.name}</span>
            </span>
          ))}
        </div>
      ) : null}
      {state.hint ? <p className="mt-1 text-xs text-mute/70">{state.hint}</p> : null}

      {task.status === 'failed' && task.error ? (
        <p className="mt-4 text-[0.85rem] text-danger">{task.error}</p>
      ) : null}

      {task.status === 'awaiting_answers' && task.questions.length > 0 ? (
        <>
          <SectionHeading>clarifying questions</SectionHeading>
          <AnswersForm task={task} onDone={refresh} />
        </>
      ) : null}

      {task.status === 'plan_ready' ? (
        <>
          <SectionHeading
            aside={
              <span className="flex items-center gap-1 text-xs text-mute">
                <MessageSquarePlus className="size-3.5" aria-hidden /> select text to comment
              </span>
            }
          >
            implementation plan
          </SectionHeading>
          <div
            ref={planRef}
            onMouseUp={onPlanSelect}
            onTouchEnd={onPlanSelect}
            className="cursor-text selection:bg-accent/30"
          >
            <Markdown>{task.plan ?? ''}</Markdown>
          </div>
          {task.acceptance.length > 0 ? (
            <>
              <div className="mt-3 text-xs text-mute">acceptance criteria</div>
              <ul className="mt-1 list-disc pl-5 text-[0.85rem]">
                {task.acceptance.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </>
          ) : null}

          {comments.length > 0 ? (
            <>
              <SectionHeading>your feedback</SectionHeading>
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
                        className="cursor-pointer p-0.5 text-mute hover:text-danger"
                        onClick={() => setComments((prev) => prev.filter((_, j) => j !== i))}
                      >
                        <X className="size-3.5" aria-hidden />
                      </button>
                    </div>
                    <p className="mt-1.5 text-[0.85rem]">{f.comment}</p>
                  </div>
                ))}
              </div>
            </>
          ) : null}

          <div className="mt-5 flex flex-col gap-2 sm:flex-row">
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

          {popover ? (
            <div
              className="fixed z-50 w-72 -translate-x-1/2 rounded-xl border border-line-2 bg-surface p-3 shadow-2xl shadow-black/60"
              style={{ left: popover.x, top: popover.y }}
            >
              <p className="line-clamp-2 text-xs text-mute italic">{popover.snippet}</p>
              <Textarea
                autoFocus
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="what should change here?"
                className="mt-2 min-h-16"
              />
              <div className="mt-2 flex justify-end gap-2">
                <Button size="sm" variant="secondary" onClick={() => setPopover(null)}>
                  Cancel
                </Button>
                <Button size="sm" onClick={addComment} disabled={!note.trim()}>
                  Add comment
                </Button>
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      {task.status === 'approved' ? (
        <div className="mt-4 flex flex-col gap-3">
          {task.repos.map((r) => {
            const stopped = !r.pr_number && GENERATION_STOPPED.has(r.feature_status ?? '');
            const tone = stopped
              ? 'red'
              : r.feature_status === 'merged' || r.pr_number
                ? 'on'
                : 'running';
            const label = stopped
              ? 'generation stopped'
              : r.feature_status === 'merged'
                ? 'merged'
                : r.pr_number
                  ? `PR #${r.pr_number}`
                  : 'generating';
            return (
              <div key={r.repository_id} className="rounded-xl bg-raised/40 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[0.85rem] font-medium">
                    {r.owner}/{r.name}
                  </span>
                  <Pill tone={tone}>{label}</Pill>
                </div>
                {stopped && r.feature_error ? (
                  <p className="mt-2 text-[0.85rem] text-danger">{r.feature_error}</p>
                ) : null}
                <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                  {stopped && r.feature_id !== null ? (
                    <Button
                      size="sm"
                      onClick={() => retry.mutate(r.feature_id as number)}
                      loading={retry.isPending && retry.variables === r.feature_id}
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
                  {r.pr_number ? (
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
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      {task.plan && task.status === 'approved' ? (
        <>
          <SectionHeading>plan</SectionHeading>
          <details className="mt-1">
            <summary className="cursor-pointer text-[0.85rem] text-mute">
              implementation plan (approved)
            </summary>
            <Markdown className="mt-1">{task.plan}</Markdown>
          </details>
        </>
      ) : null}

      <div className="mt-12 border-t border-line/60 pt-5">
        {task.archived ? (
          <Button
            variant="secondary"
            onClick={() => archive.mutate(false)}
            loading={archive.isPending}
          >
            Restore to board
          </Button>
        ) : (
          <ConfirmButton
            variant="secondary"
            title="Archive this task?"
            description="Started tasks are never deleted — archiving hides it from the board. The plan, PR, and history stay, and you can restore it from this page."
            confirmLabel="Archive"
            onConfirm={() => archive.mutate(true)}
            busy={archive.isPending}
          >
            Archive task
          </ConfirmButton>
        )}
        <p className="mt-2.5 text-xs text-mute/70">
          started tasks can't be deleted — only archived
        </p>
      </div>
    </>
  );
}
