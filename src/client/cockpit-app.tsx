/** @jsxImportSource react */
// The cockpit's interactive layer (v2): replaces the server-rendered static
// diffs with live @pierre/diffs React surfaces. Select a line range to leave a
// review comment — submitting it dispatches the fix agent against that exact
// finding. Built as a standalone ESM bundle (see scripts.build:cockpit) and
// served from the Worker's static assets; the SSR markup remains the no-JS
// fallback.
import { useCallback, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PatchDiff, type DiffLineAnnotation } from '@pierre/diffs/react';

interface CockpitFile {
	filename: string;
	status: string;
	patch: string | null;
}

interface CockpitComment {
	id: number;
	path: string;
	line: number;
	side: string;
	body: string;
	author: string;
	status: string;
	created_at: string;
}

interface CockpitData {
	featureId: number;
	prOpen: boolean;
	files: CockpitFile[];
	comments: CockpitComment[];
}

type Selection = { file: string; startLine: number; endLine: number; side: 'additions' | 'deletions' };

interface CommentMeta {
	comment?: CockpitComment;
	composer?: boolean;
}

function CommentCard({ comment }: { comment: CockpitComment }) {
	return (
		<div className="cockpit-comment">
			<div className="cockpit-comment-head">
				<strong>@{comment.author}</strong> · {comment.status === 'dispatched' ? '🔧 fix dispatched' : comment.status}
			</div>
			<div className="cockpit-comment-body">{comment.body}</div>
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
	const [busy, setBusy] = useState(false);
	const submit = useCallback(async () => {
		if (!body.trim() || busy) return;
		setBusy(true);
		const res = await fetch(`/factory/features/${featureId}/comments`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				path: selection.file,
				line: selection.endLine,
				side: selection.side,
				body: body.trim(),
			}),
		});
		setBusy(false);
		if (res.ok) onDone();
	}, [body, busy, featureId, selection, onDone]);
	return (
		<div className="cockpit-comment cockpit-composer">
			<div className="cockpit-comment-head">
				Comment on line {selection.endLine} — submitting dispatches the fix agent
			</div>
			<textarea
				autoFocus
				value={body}
				onChange={(e) => setBody((e.target as HTMLTextAreaElement).value)}
				placeholder="What should change here?"
			/>
			<div className="cockpit-composer-actions">
				<button onClick={submit} disabled={busy || !body.trim()}>
					{busy ? 'Dispatching…' : 'Comment & dispatch fix'}
				</button>
				<button className="secondary" onClick={onCancel}>
					Cancel
				</button>
			</div>
		</div>
	);
}

function FileSurface({ data, file }: { data: CockpitData; file: CockpitFile }) {
	const [selection, setSelection] = useState<Selection | null>(null);
	const [, setVersion] = useState(0);

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

	if (!file.patch) {
		return <p className="muted">{file.filename} — diff not rendered (binary, renamed, or too large)</p>;
	}
	return (
		<div>
			<div className="file-label">
				{file.filename} <span className="muted">({file.status})</span>
			</div>
			<div className="diffs-scope">
				<PatchDiff
					patch={file.patch}
					lineAnnotations={annotations}
					renderAnnotation={(a: DiffLineAnnotation<CommentMeta>) =>
						a.metadata?.composer && selection ? (
							<Composer
								selection={selection}
								featureId={data.featureId}
								onDone={() =>

									window.location.reload()
								}
								onCancel={() => setSelection(null)}
							/>
						) : a.metadata?.comment ? (
							<CommentCard comment={a.metadata.comment} />
						) : null
					}
					options={{
						theme: 'pierre-dark',
						enableLineSelection: data.prOpen,
						onLineSelectionEnd: (range: unknown) => {
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
							setVersion((v) => v + 1);
						},
					}}
				/>
			</div>
		</div>
	);
}

function CockpitApp({ data }: { data: CockpitData }) {
	return (
		<div>
			{data.prOpen ? (
				<p className="muted">select a line range in the diff to comment — comments dispatch the fix agent</p>
			) : null}
			{data.files.map((f) => (
				<FileSurface key={f.filename} data={data} file={f} />
			))}
		</div>
	);
}

const dataEl = document.getElementById('cockpit-data');
const host = document.getElementById('cockpit-diffs');
if (dataEl?.textContent && host) {
	try {
		const data = JSON.parse(dataEl.textContent) as CockpitData;
		const root = createRoot(host);
		root.render(<CockpitApp data={data} />);
	} catch (err) {
		// Leave the SSR fallback in place.
		console.error('cockpit: hydration failed, keeping static view', err);
	}
}
