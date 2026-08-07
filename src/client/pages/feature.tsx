import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { PatchDiff, type DiffLineAnnotation } from '@pierre/diffs/react';
import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { ApiCockpitComment, ApiFeatureDetail } from '../../shared/api-types.ts';
import { api, ApiError } from '../lib/api.ts';
import { featureQuery } from '../lib/queries.ts';
import { ConfirmButton } from '../components/confirm-button.tsx';
import { ensureDiffStyles } from '../components/diff-styles.ts';
import { Muted, PageTitle, SectionHeading } from '../components/section.tsx';
import { Button } from '../components/ui/button.tsx';
import { Pill } from '../components/ui/pill.tsx';
import { Table, Td } from '../components/ui/table.tsx';
import { Textarea } from '../components/ui/input.tsx';

// The factory PR cockpit: one screen for reviewing a factory PR without
// GitHub — demo video, acceptance evidence, review verdicts, the merge
// action, and the full diff. Select a line range to leave a review comment;
// submitting it dispatches the fix agent against that exact finding.

type Selection = { file: string; startLine: number; endLine: number; side: 'additions' | 'deletions' };

interface CommentMeta {
	comment?: ApiCockpitComment;
	composer?: boolean;
}

const VERDICT_BADGE: Record<string, string> = { pass: '✅', fail: '❌', skip: '⚪' };

function onApiError(err: unknown) {
	toast.error(err instanceof ApiError ? err.message : 'request failed');
}

function CommentCard({ comment }: { comment: ApiCockpitComment }) {
	return (
		<div className="m-2 rounded-md border border-line-2 border-l-2 border-l-accent bg-surface px-3 py-2 text-[0.82rem]">
			<div className="mb-1 text-xs text-mute">
				<strong>@{comment.author}</strong> ·{' '}
				{comment.status === 'dispatched' ? '🔧 fix dispatched' : comment.status}
			</div>
			<div className="whitespace-pre-wrap">{comment.body}</div>
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
			toast.success('comment posted — fix agent dispatched');
			onDone();
		},
		onError: onApiError,
	});

	return (
		<div className="m-2 rounded-md border border-line-2 border-l-2 border-l-accent bg-surface px-3 py-2">
			<div className="mb-1.5 text-xs text-mute">
				Comment on line {selection.endLine} — submitting dispatches the fix agent
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
					{submit.isPending ? 'Dispatching…' : 'Comment & dispatch fix'}
				</Button>
				<Button size="sm" variant="secondary" onClick={onCancel}>
					Cancel
				</Button>
			</div>
		</div>
	);
}

function FileSurface({
	data,
	file,
	onCommented,
}: {
	data: ApiFeatureDetail;
	file: ApiFeatureDetail['files'][number];
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
			list.push({ side: selection.side, lineNumber: selection.endLine, metadata: { composer: true } });
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
			<Muted className="mt-4 block">
				{file.filename} — diff not rendered (binary, renamed, or too large)
			</Muted>
		);
	}
	return (
		<div className="mt-4">
			<div className="mb-1.5 text-xs text-ink-dim">
				{file.filename} <Muted>({file.status})</Muted>
			</div>
			<div className="diffs-scope">
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
						enableLineSelection: prOpen,
						onLineSelectionEnd: onSelectionEnd,
					}}
				/>
			</div>
		</div>
	);
}

export default function FeaturePage() {
	ensureDiffStyles();
	const { featureId } = useParams({ from: '/factory/features/$featureId' });
	const id = Number(featureId);
	const queryClient = useQueryClient();
	const { data } = useSuspenseQuery(featureQuery(id));
	const refresh = () => queryClient.invalidateQueries({ queryKey: ['feature', id] });

	const merge = useMutation({
		mutationFn: () => api.post(`/api/factory/features/${id}/merge`),
		onSuccess: () => {
			toast.success('pull request merged');
			refresh();
		},
		onError: onApiError,
	});

	if (!data.pr) {
		return (
			<>
				<PageTitle>{data.feature.title}</PageTitle>
				<p className="mt-4">
					<Muted>No pull request yet — generation is {data.feature.status}.</Muted>
				</p>
			</>
		);
	}

	const prState = data.pr.state;
	const v = data.verification;

	return (
		<>
			<PageTitle
				aside={
					<Pill tone={prState === 'merged' ? 'on' : prState === 'open' ? 'running' : 'red'}>{prState}</Pill>
				}
			>
				{data.feature.title}
			</PageTitle>
			<p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.85rem] text-mute">
				{data.repo} · PR{' '}
				<a
					href={data.pr.html_url}
					target="_blank"
					rel="noopener"
					className="text-accent-bright hover:underline"
				>
					#{data.feature.pr_number}
				</a>{' '}
				· {data.pr.changed_files} files,{' '}
				<span className="text-accent-bright">+{data.pr.additions}</span>{' '}
				<span className="text-danger">−{data.pr.deletions}</span>
				{v ? (
					<Pill tone={v.status === 'passed' ? 'on' : v.status === 'running' ? 'running' : 'red'}>
						verify: {v.status}
						{v.status === 'passed' ? ` (${v.total}/${v.total})` : v.status === 'failed' ? ` (${v.failed} unmet)` : ''}
					</Pill>
				) : null}
			</p>

			{prState === 'open' ? (
				<div className="mt-4">
					<ConfirmButton
						title="Merge pull request?"
						description={`This merges PR #${data.feature.pr_number} into ${data.repo} on GitHub.`}
						confirmLabel="Merge"
						onConfirm={() => merge.mutate()}
						busy={merge.isPending}
					>
						Merge pull request
					</ConfirmButton>
				</div>
			) : null}

			{data.demo ? (
				<>
					<SectionHeading>demo</SectionHeading>
					{data.demo.caption ? <Muted className="mb-2 block">{data.demo.caption}</Muted> : null}
					<video
						className="w-full rounded-lg border border-line bg-black"
						controls
						autoPlay
						muted
						loop
						playsInline
						src={data.demo.url}
					/>
				</>
			) : null}

			{data.criteria.length > 0 ? (
				<>
					<SectionHeading>acceptance criteria</SectionHeading>
					<Table>
						<tbody>
							{data.criteria.map((crit, i) => (
								<tr key={i}>
									<Td className="w-6">{VERDICT_BADGE[crit.verdict ?? ''] ?? '⚪'}</Td>
									<Td>
										{crit.text}
										{crit.note ? <div className="text-xs text-mute">{crit.note}</div> : null}
										{crit.screenshot_url ? (
											<div>
												<a
													href={crit.screenshot_url}
													target="_blank"
													rel="noopener"
													className="text-xs text-accent-bright hover:underline"
												>
													screenshot →
												</a>
											</div>
										) : null}
									</Td>
								</tr>
							))}
						</tbody>
					</Table>
				</>
			) : null}

			{data.reviews.length > 0 ? (
				<>
					<SectionHeading>reviews</SectionHeading>
					{data.reviews.map((r, i) => (
						<details key={i} className="mt-2">
							<summary className="cursor-pointer text-[0.85rem]">
								{r.author ?? 'unknown'} · {r.state.toLowerCase()}
							</summary>
							<pre className="mt-1 text-xs leading-relaxed whitespace-pre-wrap text-ink-dim">
								{r.body || '(no body)'}
							</pre>
						</details>
					))}
				</>
			) : null}

			{data.plan ? (
				<>
					<SectionHeading>plan</SectionHeading>
					<details className="mt-2">
						<summary className="cursor-pointer text-[0.85rem] text-mute">
							implementation plan (approved)
						</summary>
						<pre className="mt-1 text-xs leading-relaxed whitespace-pre-wrap text-ink-dim">{data.plan}</pre>
					</details>
				</>
			) : null}

			<SectionHeading>diff</SectionHeading>
			{data.pr.state === 'open' ? (
				<Muted className="block">
					select a line range in the diff to comment — comments dispatch the fix agent
				</Muted>
			) : null}
			{data.files.map((f) => (
				<FileSurface key={f.filename} data={data} file={f} onCommented={refresh} />
			))}
			{data.more_files > 0 ? (
				<Muted className="mt-3 block">
					…and {data.more_files} more files — see the PR on GitHub.
				</Muted>
			) : null}
		</>
	);
}
