import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { maybeAutoMerge } from '../../services/auto-merge.ts';
import { maybeResolveConflict } from '../../services/merge-conflicts.ts';
import { enqueueFactoryMessage } from '../../services/factory-queue.ts';
import { completeReview, getRepoByFullName } from '../../data/db.ts';
import { installationToken } from '../../integrations/github/app.ts';
import {
  githubGraphql as ghGraphql,
  githubRequest as gh,
} from '../../integrations/github/client.ts';
import { REVIEW_NOISE_PATTERNS } from '../../domain/review-diff.ts';

export type PostReviewTool = ReturnType<typeof makePostReview>;

// The repository a review dispatch is scoped to. The model supplies
// owner/repo as tool arguments, and tokenFor resolves a full installation
// token — so without this pin a prompt-injected agent could read files from
// (or post reviews to) any other repo in the same installation. Null only on
// the operator-driven plain-message path (REVIEW_SECRET-authed /internal),
// which has no dispatch attributes to pin from.
export type RepoPin = { owner: string; repo: string } | null;

function assertPinned(pin: RepoPin, owner: string, repo: string): void {
  if (!pin) return;
  if (
    owner.toLowerCase() !== pin.owner.toLowerCase() ||
    repo.toLowerCase() !== pin.repo.toLowerCase()
  ) {
    throw new Error(
      `this review is scoped to ${pin.owner}/${pin.repo} — refusing to access ${owner}/${repo}`,
    );
  }
}

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

function truncate(text: string, max: number, label: string): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[turbodiff: ${label} truncated at ${max} characters of ${text.length}]`;
}

// Files whose diffs are machine noise: no reviewable intent, and large enough
// to eat the truncation budget before the real code gets seen. Also consumed
// by the risk-tier computation (src/domain/review-diff.ts) so noise churn doesn't
// inflate a PR's reviewable size.
// An @generated marker in a file's header comment means machine output —
// except migrations, whose generated SQL still changes schema and needs
// review. Only the first hunk is checked, and only when it starts at the top
// of the new file: the marker convention is "first few lines", and matching
// deeper would drop files that merely mention @generated in code.
function isGeneratedSegment(path: string, segment: string): boolean {
  if (/migration/i.test(path)) return false;
  const hunk = segment.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@.*$/m);
  if (!hunk || Number(hunk[1]) > 3) return false;
  const start = segment.indexOf(hunk[0]) + hunk[0].length;
  return segment
    .slice(start)
    .split('\n', 10)
    .some((line) => line.includes('@generated'));
}

// Replaces each noise file's segment of the unified diff with a one-line
// marker, so the model knows the file changed without reading it and the
// MAX_DIFF_CHARS budget goes to reviewable code. Runs before truncation.
function filterDiffNoise(diff: string): string {
  return diff
    .split(/^(?=diff --git )/m)
    .map((segment) => {
      const header = segment.match(/^diff --git "?a\/.+?"? "?b\/(.+?)"?$/m);
      if (!header) return segment;
      const path = header[1];
      const reason =
        REVIEW_NOISE_PATTERNS.find((n) => n.pattern.test(path))?.reason ??
        (isGeneratedSegment(path, segment) ? 'generated file' : null);
      return reason === null ? segment : `[turbodiff: diff for ${path} omitted — ${reason}]\n`;
    })
    .join('');
}

// Per-render factories (like makePostReview): each dispatch pins its tools
// to the PR's own repository.
export const makeFetchPr = (pin: RepoPin) =>
  defineTool({
    name: 'fetch_pr',
    description:
      'Fetch a pull request: its title, description, author, branch info, and the full unified diff. ' +
      'Call this first to see what the PR changes. Large diffs are truncated with a marker; noise ' +
      'files (lockfiles, minified assets, source maps, generated code) are omitted and replaced ' +
      'with per-file markers.',
    input: v.object({
      owner: v.string(),
      repo: v.string(),
      number: v.number(),
    }),
    async run({ data }) {
      assertPinned(pin, data.owner, data.repo);
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
        gh(token, base).then((r) => r.json<PrMeta>()),
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
          diff: truncate(filterDiffNoise(diff), MAX_DIFF_CHARS, 'diff'),
        },
      };
    },
  });

export const makeFetchFile = (pin: RepoPin) =>
  defineTool({
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
      assertPinned(pin, data.owner, data.repo);
      const token = await tokenFor(data.owner, data.repo);
      const res = await gh(
        token,
        `/repos/${data.owner}/${data.repo}/contents/${data.path}?ref=${encodeURIComponent(data.ref)}`,
        { accept: 'application/vnd.github.raw+json' },
      );
      return { output: truncate(await res.text(), MAX_FILE_CHARS, `file ${data.path}`) };
    },
  });

// GraphQL is the only API surface that exposes review-thread resolution
// state, which the re-review rules depend on.
const THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
	repository(owner: $owner, name: $repo) {
		pullRequest(number: $number) {
			reviews(last: 30) {
				nodes { author { login } state body submittedAt }
			}
			reviewThreads(first: 100) {
				nodes {
					isResolved
					isOutdated
					path
					line
					comments(first: 20) {
						nodes { author { login } body createdAt }
					}
				}
			}
		}
	}
}`;

interface ThreadsQueryResult {
  repository: {
    pullRequest: {
      reviews: {
        nodes: {
          author: { login: string } | null;
          state: string;
          body: string;
          submittedAt: string;
        }[];
      };
      reviewThreads: {
        nodes: {
          isResolved: boolean;
          isOutdated: boolean;
          path: string;
          line: number | null;
          comments: {
            nodes: { author: { login: string } | null; body: string; createdAt: string }[];
          };
        }[];
      };
    } | null;
  } | null;
}

const MAX_THREAD_BODY_CHARS = 2_000;

export const makeFetchReviewThreads = (pin: RepoPin) =>
  defineTool({
    name: 'fetch_review_threads',
    description:
      'Fetch the existing reviews and inline comment threads on a pull request, including each ' +
      "thread's resolution state and any replies. Call this on a re-review to reconcile your " +
      'earlier findings with what happened since: which threads were resolved, and how the ' +
      'author responded.',
    input: v.object({
      owner: v.string(),
      repo: v.string(),
      number: v.number(),
    }),
    async run({ data }) {
      assertPinned(pin, data.owner, data.repo);
      const token = await tokenFor(data.owner, data.repo);
      const result = await ghGraphql<ThreadsQueryResult>(token, THREADS_QUERY, {
        owner: data.owner,
        repo: data.repo,
        number: data.number,
      });
      const pr = result.repository?.pullRequest;
      if (!pr) throw new Error(`pull request ${data.owner}/${data.repo}#${data.number} not found`);
      const clip = (text: string) => truncate(text, MAX_THREAD_BODY_CHARS, 'comment');
      return {
        output: {
          reviews: pr.reviews.nodes.map((r) => ({
            author: r.author?.login ?? 'unknown',
            state: r.state,
            submittedAt: r.submittedAt,
            body: clip(r.body),
          })),
          threads: pr.reviewThreads.nodes.map((t) => ({
            path: t.path,
            line: t.line,
            resolved: t.isResolved,
            outdated: t.isOutdated,
            comments: t.comments.nodes.map((c) => ({
              author: c.author?.login ?? 'unknown',
              createdAt: c.createdAt,
              body: clip(c.body),
            })),
          })),
        },
      };
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
  // Drives the review verdict in blocking mode; must match the body's tag.
  severity: v.optional(v.picklist(['P1', 'P2']), 'P2'),
  body: v.pipe(v.string(), v.minLength(1)),
});

// Severity gates merges in blocking mode, so the model's structured field is
// not trusted alone: the body's visible tag is an independent claim of the
// same fact. A finding counts as P1 when either says so — a mislabel can then
// only escalate (a spurious REQUEST_CHANGES a re-review clears), never
// silently APPROVE past a real P1 — and disagreements are logged.
function findingSeverity(f: v.InferOutput<typeof findingSchema>): 'P1' | 'P2' {
  const bodyTagged = f.body.includes('**P1**') || f.body.includes('\u{1F534}');
  if (bodyTagged !== (f.severity === 'P1')) {
    console.warn(
      `turbodiff: severity mismatch on finding ${f.path}:${f.line} — field says ${f.severity}, ` +
        `body ${bodyTagged ? 'is' : 'is not'} tagged P1; treating as P1`,
    );
  }
  return bodyTagged || f.severity === 'P1' ? 'P1' : 'P2';
}

function findingsAsMarkdown(findings: v.InferOutput<typeof findingSchema>[]): string {
  return findings.map((f) => `**\`${f.path}:${f.line}\`**\n${f.body}`).join('\n\n');
}

// One inline comment in a POST /pulls/:number/reviews payload (GitHub's
// snake_case field names).
interface ReviewComment {
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  body: string;
  start_line?: number;
  start_side?: 'LEFT' | 'RIGHT';
}

// A per-render factory rather than a shared definition: the tool closes over
// the agent instance id so completing the D1 review row targets exactly the
// dispatch that ran it — concurrent agents on the same PR never collide.
export const makePostReview = (agentInstanceId: string, pin: RepoPin = null) =>
  defineTool({
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
      assertPinned(pin, data.owner, data.repo);
      const row = await getRepoByFullName(data.owner, data.repo);
      if (!row) {
        throw new Error(
          `Turbodiff is not installed on ${data.owner}/${data.repo} (no installation found). ` +
            'Install the GitHub App on this repository first.',
        );
      }
      const token = await installationToken(row.installation_id);
      // Verdict mapping (repo blocking mode, default off): a P1 requests
      // changes, a clean or P2-only review approves. Off posts plain
      // comments — today's behavior. The bot's latest review state wins on
      // GitHub, so a re-review that finds the P1s fixed clears the block.
      const event =
        row.blocking_reviews !== 1
          ? 'COMMENT'
          : data.findings.map(findingSeverity).includes('P1')
            ? 'REQUEST_CHANGES'
            : 'APPROVE';
      const path = `/repos/${data.owner}/${data.repo}/pulls/${data.number}/reviews`;
      const comments = data.findings.map((f) => {
        const comment: ReviewComment = { path: f.path, line: f.line, side: f.side, body: f.body };
        if (f.startLine !== undefined) {
          comment.start_line = f.startLine;
          comment.start_side = f.side;
        }
        return comment;
      });

      // Two recoverable 422 classes, retried in a bounded loop:
      //   - self-authored PR: GitHub refuses APPROVE/REQUEST_CHANGES from the
      //     PR author (factory-generated PRs) — downgrade to COMMENT, keeping
      //     the intended verdict visible in the body.
      //   - bad anchor: any single comment outside the diff fails the whole
      //     review — fold findings into the summary body.
      const intended = event;
      let postEvent = event;
      let postBody = data.body;
      let postComments = comments;
      let fallback: string | null = null;
      let review: { html_url?: string };
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await gh(token, path, {
            method: 'POST',
            body: JSON.stringify({ body: postBody, event: postEvent, comments: postComments }),
          });
          review = await res.json<{ html_url?: string }>();
          break;
        } catch (err) {
          const msg = String(err);
          if (!msg.includes('422') || attempt >= 2) throw err;
          if (/own pull request/i.test(msg) && postEvent !== 'COMMENT') {
            postEvent = 'COMMENT';
            postBody =
              `**Verdict: ${intended}** _(posted as a comment — GitHub does not let the PR author ` +
              `review its own pull request)_\n\n${postBody}`;
            fallback = 'self-authored PR: verdict downgraded to COMMENT';
          } else if (postComments.length > 0) {
            postBody = `${postBody}\n\n### Findings\n\n${findingsAsMarkdown(data.findings)}`;
            postComments = [];
            fallback =
              'inline comments failed to anchor; findings were folded into the review body';
          } else {
            throw err;
          }
        }
      }
      const output = {
        posted: true,
        inline: postComments.length,
        url: review.html_url ?? null,
        fallback,
      };
      // Flip this dispatch's row to completed so /reviews stops showing it
      // as running. The findings count feeds the noise metric on the
      // dashboard (fallback-posted findings still count — they reached the PR).
      await completeReview(agentInstanceId, output.url, data.findings.length);
      // Factory-PR gate: a blocking verdict on a self-authored PR never fires
      // the pull_request_review webhook trigger (the posted state is COMMENT),
      // so enqueue the fix directly. The consumer re-validates toggle and cap.
      if (intended === 'REQUEST_CHANGES' && postEvent === 'COMMENT' && row.auto_fix === 1) {
        await enqueueFactoryMessage({
          kind: 'fix',
          repoId: row.id,
          prNumber: data.number,
          trigger: 'blocking_review_self',
        });
      }
      // Conflict detection runs on every review completion, blocking or not
      // (a blocking verdict skips only the merge gate below).
      await maybeResolveConflict(row, data.number);
      // Clean verdict on a factory PR: the verification may already have
      // passed while this review was running — try the merge gate now.
      if (intended !== 'REQUEST_CHANGES') {
        await maybeAutoMerge(row, data.number);
      }
      return { output };
    },
  });
