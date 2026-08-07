import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import type { ApiPlan } from '../../shared/api-types.ts';
import { api, ApiError } from '../lib/api.ts';
import { ago } from '../lib/format.ts';
import { factoryQuery } from '../lib/queries.ts';
import { EmptyState, Muted, PageTitle, SectionHeading } from '../components/section.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card } from '../components/ui/card.tsx';
import { Field, Input, Select, Textarea } from '../components/ui/input.tsx';
import { Pill } from '../components/ui/pill.tsx';

const PLAN_STATUS_HINT: Record<string, string> = {
	analyzing: 'analyzing the repo and drafting clarifying questions…',
	awaiting_answers: 'answer the questions below to continue',
	refining: 'incorporating your answers into the plan…',
	plan_ready: 'review the plan and approve to generate',
	approved: 'generating — follow the pull request',
	failed: 'failed — see the error',
};

const RUNNING_PLAN_STATUSES = new Set(['analyzing', 'refining']);

function onApiError(err: unknown) {
	toast.error(err instanceof ApiError ? err.message : 'request failed');
}

function VerificationPill({ plan }: { plan: ApiPlan }) {
	const v = plan.verification;
	if (!v) return null;
	const detail =
		v.status === 'passed'
			? ` (${v.total}/${v.total})`
			: v.status === 'failed'
				? ` (${v.failed} unmet)`
				: '';
	const tone = v.status === 'passed' ? 'on' : v.status === 'running' ? 'running' : 'red';
	return (
		<Pill tone={tone}>
			verify: {v.status}
			{detail}
		</Pill>
	);
}

function NewFeatureForm({ repos }: { repos: { id: number; owner: string; name: string }[] }) {
	const queryClient = useQueryClient();
	const [title, setTitle] = useState('');
	const [requirements, setRequirements] = useState('');
	const [repo, setRepo] = useState(repos[0] ? `${repos[0].owner}/${repos[0].name}` : '');

	const submit = useMutation({
		mutationFn: () => api.post('/api/factory/plans', { repo, title, requirements }),
		onSuccess: () => {
			setTitle('');
			setRequirements('');
			toast.success('plan queued — the planning agent is reading your repo');
			queryClient.invalidateQueries({ queryKey: ['factory'] });
		},
		onError: onApiError,
	});

	const onSubmit = (e: FormEvent) => {
		e.preventDefault();
		if (!title.trim() || !requirements.trim() || !repo) return;
		submit.mutate();
	};

	return (
		<form onSubmit={onSubmit}>
			<Field label="repository">
				<Select value={repo} onChange={(e) => setRepo(e.target.value)} required>
					{repos.map((r) => (
						<option key={r.id} value={`${r.owner}/${r.name}`}>
							{r.owner}/{r.name}
						</option>
					))}
				</Select>
			</Field>
			<Field label="title">
				<Input
					value={title}
					onChange={(e) => setTitle(e.target.value)}
					required
					placeholder="short feature name"
				/>
			</Field>
			<Field label="requirements">
				<Textarea
					value={requirements}
					onChange={(e) => setRequirements(e.target.value)}
					required
					placeholder="Describe what you want built. The planning agent reads your repo, asks clarifying questions, and drafts a plan you approve before any code is written."
				/>
			</Field>
			<div className="mt-4">
				<Button type="submit" loading={submit.isPending}>
					Plan feature
				</Button>
			</div>
		</form>
	);
}

function AnswersForm({ plan }: { plan: ApiPlan }) {
	const queryClient = useQueryClient();
	const [answers, setAnswers] = useState<string[]>(() => plan.questions.map(() => ''));
	const submit = useMutation({
		mutationFn: () => api.post(`/api/factory/plans/${plan.id}/answers`, { answers }),
		onSuccess: () => {
			toast.success('answers submitted — refining the plan');
			queryClient.invalidateQueries({ queryKey: ['factory'] });
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
			{plan.questions.map((q, i) => (
				<Field key={i} label={q}>
					<Input
						value={answers[i] ?? ''}
						onChange={(e) =>
							setAnswers((prev) => prev.map((a, j) => (j === i ? e.target.value : a)))
						}
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

function PlanCard({ plan }: { plan: ApiPlan }) {
	const queryClient = useQueryClient();
	const running = RUNNING_PLAN_STATUSES.has(plan.status);
	const approve = useMutation({
		mutationFn: () => api.post(`/api/factory/plans/${plan.id}/approve`),
		onSuccess: () => {
			toast.success('plan approved — generation queued');
			queryClient.invalidateQueries({ queryKey: ['factory'] });
		},
		onError: onApiError,
	});

	return (
		<Card className="mt-3">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<strong className="font-medium">{plan.title}</strong>
				<Pill tone={running ? 'running' : plan.status === 'failed' ? 'red' : 'on'}>{plan.status}</Pill>
			</div>
			<div className="mt-0.5 text-xs text-mute">
				{plan.repo} · {PLAN_STATUS_HINT[plan.status] ?? ''} · {ago(plan.created_at)}
			</div>

			{plan.status === 'failed' && plan.error ? (
				<p className="mt-3 text-[0.85rem] text-danger">{plan.error}</p>
			) : null}

			{plan.status === 'awaiting_answers' && plan.questions.length > 0 ? (
				<AnswersForm plan={plan} />
			) : null}

			{plan.status === 'plan_ready' ? (
				<>
					<details open className="mt-3">
						<summary className="cursor-pointer text-[0.85rem] text-mute">implementation plan</summary>
						<pre className="mt-2 text-xs leading-relaxed whitespace-pre-wrap text-ink-dim">{plan.plan ?? ''}</pre>
						{plan.acceptance.length > 0 ? (
							<>
								<div className="mt-2 text-xs text-mute">acceptance criteria</div>
								<ul className="mt-1 list-disc pl-5 text-[0.85rem]">
									{plan.acceptance.map((a, i) => (
										<li key={i}>{a}</li>
									))}
								</ul>
							</>
						) : null}
					</details>
					<div className="mt-3">
						<Button onClick={() => approve.mutate()} loading={approve.isPending}>
							Approve &amp; generate
						</Button>
					</div>
				</>
			) : null}

			{plan.status === 'approved' && plan.pr_number ? (
				<p className="mt-3 flex flex-wrap items-center gap-2 text-[0.85rem]">
					{plan.feature_id !== null ? (
						<Link
							to="/factory/features/$featureId"
							params={{ featureId: String(plan.feature_id) }}
							className="font-medium text-accent-bright hover:underline"
						>
							open in cockpit &rarr;
						</Link>
					) : null}
					<a
						href={`https://github.com/${plan.repo}/pull/${plan.pr_number}`}
						target="_blank"
						rel="noopener"
						className="text-accent-bright hover:underline"
					>
						PR #{plan.pr_number}
					</a>
					<VerificationPill plan={plan} />
				</p>
			) : null}
		</Card>
	);
}

export function FactoryPage() {
	const { data } = useSuspenseQuery(factoryQuery);

	return (
		<>
			<PageTitle>factory</PageTitle>

			<SectionHeading>new feature</SectionHeading>
			{data.repos.length === 0 ? (
				<EmptyState>
					Enable the factory on a repository in{' '}
					<Link to="/settings" className="text-accent-bright hover:underline">
						settings
					</Link>{' '}
					to plan features for it.
				</EmptyState>
			) : (
				<NewFeatureForm repos={data.repos} />
			)}

			<SectionHeading aside={<Muted>{data.plans.length}</Muted>}>plans</SectionHeading>
			{data.plans.length === 0 ? (
				<EmptyState>No plans yet.</EmptyState>
			) : (
				data.plans.map((p) => <PlanCard key={p.id} plan={p} />)
			)}
		</>
	);
}
