import { defineTool } from '@flue/runtime';
import { env } from 'cloudflare:workers';
import * as v from 'valibot';

const API = 'https://api.github.com';
const MAX_DIFF_CHARS = 300_000;
const MAX_FILE_CHARS = 60_000;

async function gh(path: string, init?: RequestInit & { accept?: string }): Promise<Response> {
	const res = await fetch(`${API}${path}`, {
		...init,
		headers: {
			accept: init?.accept ?? 'application/vnd.github+json',
			authorization: `Bearer ${env.GITHUB_TOKEN}`,
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
		const base = `/repos/${data.owner}/${data.repo}/pulls/${data.number}`;
		const [meta, diff] = await Promise.all([
			gh(base).then((r) => r.json() as Promise<PrMeta>),
			gh(base, { accept: 'application/vnd.github.v3.diff' }).then((r) => r.text()),
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
		const res = await gh(
			`/repos/${data.owner}/${data.repo}/contents/${data.path}?ref=${encodeURIComponent(data.ref)}`,
			{ accept: 'application/vnd.github.raw+json' },
		);
		return { output: truncate(await res.text(), MAX_FILE_CHARS, `file ${data.path}`) };
	},
});

export const postReview = defineTool({
	name: 'post_review',
	description:
		'Post the finished review to the pull request as a single review comment (markdown). ' +
		'Call this exactly once, after you have examined the diff and gathered any needed file context.',
	input: v.object({
		owner: v.string(),
		repo: v.string(),
		number: v.number(),
		body: v.pipe(v.string(), v.minLength(1)),
	}),
	async run({ data }) {
		const res = await gh(`/repos/${data.owner}/${data.repo}/pulls/${data.number}/reviews`, {
			method: 'POST',
			body: JSON.stringify({ body: data.body, event: 'COMMENT' }),
		});
		const review = (await res.json()) as { html_url?: string };
		return { output: { posted: true, url: review.html_url ?? null } };
	},
});
