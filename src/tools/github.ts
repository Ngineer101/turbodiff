import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { completeReview, getRepoByFullName } from '../lib/db.ts';
import { installationToken } from '../lib/github-app.ts';

const API = 'https://api.github.com';
const MAX_DIFF_CHARS = 300_000;
const MAX_FILE_CHARS = 60_000;

// Every GitHub call authenticates as the App installation that owns the repo.
// The repo -> installation mapping lives in D1 (synced by the webhook handler),
// so a review can only touch repos where Turbodiff is actually installed.
async function tokenFor(owner: string, repo: string): Promise<string> {
	const row = await getRepoByFullName(owner, repo);
	if (!row) {
		throw new Error(
			`Turbodiff is not installed on ${owner}/${repo} (no installation found). ` +
				'Install the GitHub App on this repository first.',
		);
	}
	return installationToken(row.installation_id);
}

async function gh(
	token: string,
	path: string,
	init?: RequestInit & { accept?: string },
): Promise<Response> {
	const res = await fetch(`${API}${path}`, {
		...init,
		headers: {
			accept: init?.accept ?? 'application/vnd.github+json',
			authorization: `Bearer ${token}`,
			'user-agent': 'turbodiff-pr-reviewer',
			'x-github-api-version': '2022-11-28',
			...(init?.body ? { 'content-type': 'application/json' } : {}),
		},
	});
	if (!res.ok) {
		throw new Error(`GitHub API ${res.status} on ${path}: ${(await res.text()).slice(0, 500)}`);
	}
	return res;
}

function truncate(text: string, max: number, label: string): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n\n[turbodiff: ${label} truncated at ${max} characters of ${text.length}]`;
}

export const fetchPr = defineTool({
	name: 'fetch_pr',
	description:
		'Fetch a pull request: its title, description, author, branch info, and the full unified diff. ' +
		'Call this first to see what the PR changes. Large diffs are truncated with a marker.',
	input: v.object({
		owner: v.string(),
		repo: v.string(),
		number: v.number(),
	}),
	async run({ data }) {
		interface PrMeta {
			title: string;
			body: string | null;
			user: { login: string } | null;
			base: { ref: string };
			head: { ref: string; sha: string };
			draft: boolean;
			changed_files: number;
			additions: number;
			deletions: number;
		}
		const token = await tokenFor(data.owner, data.repo);
		const base = `/repos/${data.owner}/${data.repo}/pulls/${data.number}`;
		const [meta, diff] = await Promise.all([
			gh(token, base).then((r) => r.json() as Promise<PrMeta>),
			gh(token, base, { accept: 'application/vnd.github.v3.diff' }).then((r) => r.text()),
		]);
		return {
			output: {
				title: meta.title,
				body: meta.body ?? '',
				author: meta.user?.login ?? 'unknown',
				baseRef: meta.base.ref,
				headRef: meta.head.ref,
				headSha: meta.head.sha,
				draft: meta.draft,
				changedFiles: meta.changed_files,
				additions: meta.additions,
				deletions: meta.deletions,
				diff: truncate(diff, MAX_DIFF_CHARS, 'diff'),
			},
		};
	},
});

export const fetchFile = defineTool({
	name: 'fetch_file',
	description:
		'Fetch the full contents of one file from the repository at a given ref (branch or commit SHA). ' +
		'Use this when the diff alone lacks context — e.g. to see the whole function or module a hunk touches. ' +
		'Use the PR headSha to read the changed version, or the base branch name for the original.',
	input: v.object({
		owner: v.string(),
		repo: v.string(),
		path: v.string(),
		ref: v.string(),
	}),
	async run({ data }) {
		const token = await tokenFor(data.owner, data.repo);
		const res = await gh(
			token,
			`/repos/${data.owner}/${data.repo}/contents/${data.path}?ref=${encodeURIComponent(data.ref)}`,
			{ accept: 'application/vnd.github.raw+json' },
		);
		return { output: truncate(await res.text(), MAX_FILE_CHARS, `file ${data.path}`) };
	},
});

const findingSchema = v.object({
	path: v.pipe(v.string(), v.minLength(1)),
	// Line number in the file's NEW version (side RIGHT) or OLD version (side
	// LEFT). Must be a line that appears in the diff, or GitHub rejects it.
	line: v.pipe(v.number(), v.integer(), v.minValue(1)),
	side: v.optional(v.picklist(['LEFT', 'RIGHT']), 'RIGHT'),
	// Optional start of a multi-line range; must be < line and in the same hunk.
	startLine: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
	body: v.pipe(v.string(), v.minLength(1)),
});

function findingsAsMarkdown(findings: v.InferOutput<typeof findingSchema>[]): string {
	return findings
		.map((f) => `**\`${f.path}:${f.line}\`**\n${f.body}`)
		.join('\n\n');
}

export const postReview = defineTool({
	name: 'post_review',
	description:
		'Post the finished review to the pull request: a short summary body plus inline comments ' +
		'anchored to specific lines of the diff. Call this exactly once per review request (a re-review ' +
		'of the same PR posts a new review). Each comment must anchor to ' +
		'a line that is part of the diff (use side RIGHT with new-file line numbers for added/context ' +
		'lines, side LEFT with old-file line numbers for deleted lines). Findings about code outside ' +
		'the diff belong in the summary body instead.',
	input: v.object({
		owner: v.string(),
		repo: v.string(),
		number: v.number(),
		body: v.pipe(v.string(), v.minLength(1)),
		findings: v.optional(v.array(findingSchema), []),
	}),
	async run({ data }) {
		const token = await tokenFor(data.owner, data.repo);
		const path = `/repos/${data.owner}/${data.repo}/pulls/${data.number}/reviews`;
		const comments = data.findings.map((f) => ({
			path: f.path,
			line: f.line,
			side: f.side,
			...(f.startLine !== undefined ? { start_line: f.startLine, start_side: f.side } : {}),
			body: f.body,
		}));

		let output: { posted: boolean; inline: number; url: string | null; fallback: string | null };
		try {
			const res = await gh(token, path, {
				method: 'POST',
				body: JSON.stringify({ body: data.body, event: 'COMMENT', comments }),
			});
			const review = (await res.json()) as { html_url?: string };
			output = {
				posted: true,
				inline: comments.length,
				url: review.html_url ?? null,
				fallback: null,
			};
		} catch (err) {
			// GitHub 422s the whole review if any single comment anchors outside
			// the diff. Rather than lose the review, repost with the findings
			// folded into the summary body.
			if (comments.length === 0 || !String(err).includes('422')) throw err;
			const fallbackBody = `${data.body}\n\n### Findings\n\n${findingsAsMarkdown(data.findings)}`;
			const res = await gh(token, path, {
				method: 'POST',
				body: JSON.stringify({ body: fallbackBody, event: 'COMMENT' }),
			});
			const review = (await res.json()) as { html_url?: string };
			output = {
				posted: true,
				inline: 0,
				url: review.html_url ?? null,
				fallback: 'inline comments failed to anchor; findings were folded into the review body',
			};
		}
		// Flip the dispatch row to completed so /reviews stops showing it as running.
		const row = await getRepoByFullName(data.owner, data.repo);
		if (row) await completeReview(row.id, data.number, output.url);
		return { output };
	},
});
