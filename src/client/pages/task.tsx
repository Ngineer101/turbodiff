import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { ApiPlan } from '../../shared/api-types.ts';
import { api, ApiError } from '../lib/api.ts';
import { ago } from '../lib/format.ts';
import { GENERATION_STOPPED, taskQuery } from '../lib/queries.ts';
import { taskState } from '../lib/task-state.ts';
import { ConfirmButton } from '../components/confirm-button.tsx';
import { Muted, PageTitle, SectionHeading } from '../components/section.tsx';
import { Button } from '../components/ui/button.tsx';
import { Field, Input } from '../components/ui/input.tsx';
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

	const genStopped =
		task.status === 'approved' && !task.pr_number && GENERATION_STOPPED.has(task.feature_status ?? '');

	return (
		<>
			<Link to="/" className="inline-flex items-center gap-1.5 text-xs text-mute hover:text-ink">
				<ArrowLeft className="size-3.5" aria-hidden /> board
			</Link>
			<div className="mt-2">
				<PageTitle aside={<Pill tone={state.tone}>{state.label}</Pill>}>{task.title}</PageTitle>
			</div>
			<p className="mt-1 text-[0.85rem] text-mute">
				{task.repo} · {state.hint} · {ago(task.created_at)}
				{task.archived ? ' · archived' : ''}
			</p>

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
					<SectionHeading>implementation plan</SectionHeading>
					<pre className="text-xs leading-relaxed whitespace-pre-wrap text-ink-dim">{task.plan ?? ''}</pre>
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
					<div className="mt-4">
						<Button onClick={() => approve.mutate()} loading={approve.isPending}>
							Approve &amp; generate
						</Button>
					</div>
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
				<p className="mt-4 flex flex-wrap items-center gap-2 text-[0.85rem]">
					{task.feature_id !== null ? (
						<Link
							to="/factory/features/$featureId"
							params={{ featureId: String(task.feature_id) }}
							className="font-medium text-accent-bright hover:underline"
						>
							open in cockpit &rarr;
						</Link>
					) : null}
					<a
						href={`https://github.com/${task.repo}/pull/${task.pr_number}`}
						target="_blank"
						rel="noopener"
						className="text-accent-bright hover:underline"
					>
						PR #{task.pr_number} on GitHub
					</a>
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
				</p>
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

			<div className="mt-8 border-t border-line pt-4">
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
				<Muted className="ml-3">started tasks can't be deleted — only archived</Muted>
			</div>
		</>
	);
}
