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
import { SectionHeading } from '../components/section.tsx';
import { Button, buttonVariants } from '../components/ui/button.tsx';
import { Field, Input, Textarea } from '../components/ui/input.tsx';
import { Pill } from '../components/ui/pill.tsx';

function onApiError(err: unknown) {
	toast.error(err instanceof ApiError ? err.message : 'request failed');
}

function AnswersForm({ task, onDone }: { task: ApiPlan; onDone: () => void }) {
	const [answers, setAnswers] = useState<string[]>(() => task.questions.map(() => ''));
	const submit = useMutation({
		mutationFn: () => api.post(`/api/factory/plans/${task.id}/answers`, { answers }),
		onSuccess: () => {
			toast.success('answers submitted — refining the plan');
			onDone();
		},
		onError: onApiError,
	});
	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				submit.mutate();
			}}
		>
			{task.questions.map((q, i) => (
				<Field key={i} label={q}>
					<Input
						value={answers[i] ?? ''}
						onChange={(e) => setAnswers((prev) => prev.map((a, j) => (j === i ? e.target.value : a)))}
						placeholder="your answer"
					/>
				</Field>
			))}
			<div className="mt-3">
				<Button type="submit" loading={submit.isPending}>
					Submit answers
				</Button>
			</div>
		</form>
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
	const retry = useMutation({
		mutationFn: () => api.post(`/api/factory/features/${task.feature_id}/retry`),
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
	const planRef = useRef<HTMLPreElement>(null);
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

	const genStopped =
		task.status === 'approved' && !task.pr_number && GENERATION_STOPPED.has(task.feature_status ?? '');

	return (
		<>
			<Link to="/" className="inline-flex items-center gap-1.5 py-1 text-xs text-mute hover:text-ink">
				<ArrowLeft className="size-3.5" aria-hidden /> board
			</Link>
			<h1 className="mt-2 text-base leading-snug font-medium break-words sm:text-xl">{task.title}</h1>
			<div className="mt-3 flex flex-wrap items-center gap-2">
				<Pill tone={state.tone}>{state.label}</Pill>
				{task.verification ? (
					<Pill
						tone={
							task.verification.status === 'passed'
								? 'on'
								: task.verification.status === 'running'
									? 'running'
									: 'red'
						}
					>
						verify: {task.verification.status}
						{task.verification.status === 'failed' ? ` (${task.verification.failed} unmet)` : ''}
					</Pill>
				) : null}
				{task.archived ? <Pill>archived</Pill> : null}
			</div>
			<p className="mt-2.5 text-xs text-mute sm:text-[0.85rem]">
				{task.repo} · {ago(task.created_at)}
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
					<pre
						ref={planRef}
						onMouseUp={onPlanSelect}
						onTouchEnd={onPlanSelect}
						className="cursor-text text-xs leading-relaxed whitespace-pre-wrap text-ink-dim selection:bg-accent/30"
					>
						{task.plan ?? ''}
					</pre>
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

			{genStopped ? (
				<>
					{task.feature_error ? (
						<p className="mt-4 text-[0.85rem] text-danger">{task.feature_error}</p>
					) : null}
					<div className="mt-4">
						<Button onClick={() => retry.mutate()} loading={retry.isPending}>
							Retry generation
						</Button>
					</div>
				</>
			) : null}

			{task.status === 'approved' && task.pr_number ? (
				<div className="mt-6 flex flex-col gap-2 sm:flex-row">
					{task.feature_id !== null ? (
						<Link
							to="/factory/features/$featureId"
							params={{ featureId: String(task.feature_id) }}
							className={cn(buttonVariants({ variant: 'default' }), 'w-full sm:w-auto')}
						>
							Open in cockpit
						</Link>
					) : null}
					<a
						href={`https://github.com/${task.repo}/pull/${task.pr_number}`}
						target="_blank"
						rel="noopener"
						className={cn(buttonVariants({ variant: 'secondary' }), 'w-full sm:w-auto')}
					>
						PR #{task.pr_number} on GitHub
					</a>
				</div>
			) : null}

			{task.plan && task.status === 'approved' ? (
				<>
					<SectionHeading>plan</SectionHeading>
					<details className="mt-1">
						<summary className="cursor-pointer text-[0.85rem] text-mute">implementation plan (approved)</summary>
						<pre className="mt-1 text-xs leading-relaxed whitespace-pre-wrap text-ink-dim">{task.plan}</pre>
					</details>
				</>
			) : null}

			<div className="mt-12 border-t border-line/60 pt-5">
				{task.archived ? (
					<Button variant="secondary" onClick={() => archive.mutate(false)} loading={archive.isPending}>
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
				<p className="mt-2.5 text-xs text-mute/70">started tasks can't be deleted — only archived</p>
			</div>
		</>
	);
}
