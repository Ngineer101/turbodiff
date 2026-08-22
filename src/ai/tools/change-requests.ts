import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import {
  addCrComment,
  completeReview,
  getChangeRequest,
  getRepoByFullName,
  listCrComments,
  setChangeRequestReviewStatus,
  upsertCrCheck,
  type ChangeRequestRow,
  type RepositoryRow,
} from '../../data/db.ts';
import {
  CR_BOT_AUTHOR,
  getCrDiffPatch,
  maybeAutoMergeCr,
  parseCrFiles,
} from '../../services/change-requests.ts';
import { CR_BRANCH_NAME, CR_DIR } from '../runtime/cr-engine.ts';
import { enqueueFactoryMessage } from '../../services/factory-queue.ts';
import { generationSandbox } from '../runtime/sandbox.ts';
import { cockpitFeatureUrl } from '../../services/urls.ts';
import {
  assertPinned,
  filterDiffNoise,
  findingSchema,
  findingSeverity,
  truncate,
  MAX_DIFF_CHARS,
  MAX_FILE_CHARS,
} from './github.ts';

// Native change-request tools for the PrReviewer agent
// (docs/artifacts-provider.md). Deliberately the SAME tool names and input
// shapes as the GitHub set in ./github.ts, so every configured agent persona
// — whose instructions reference fetch_pr / fetch_file / post_review — works
// identically on a native CR. Only the transport differs: the diff comes
// from the CR's R2 cache, file contents from git in the synced sandbox
// workspace, and the review lands in cr_comments + the CR verdict instead of
// the GitHub reviews API.

// The change request a review dispatch is scoped to — the CR-side RepoPin.
// Never null: native reviews only ever arrive via dispatch attributes.
export interface CrPin {
  owner: string;
  repo: string;
  number: number;
  changeRequestId: number;
}

function assertCrPinned(pin: CrPin, owner: string, repo: string): void {
  assertPinned({ owner: pin.owner, repo: pin.repo }, owner, repo);
}

async function pinnedCr(pin: CrPin): Promise<{ cr: ChangeRequestRow; repo: RepositoryRow }> {
  const cr = await getChangeRequest(pin.changeRequestId);
  if (!cr) throw new Error(`change request ${pin.changeRequestId} no longer exists`);
  const repo = await getRepoByFullName(pin.owner, pin.repo);
  if (!repo || repo.id !== cr.repository_id) {
    throw new Error(
      `change request ${pin.changeRequestId} does not belong to ${pin.owner}/${pin.repo}`,
    );
  }
  return { cr, repo };
}

export const makeFetchCr = (pin: CrPin) =>
  defineTool({
    name: 'fetch_pr',
    description:
      'Fetch the change request under review: its title, description, branch info, and the full ' +
      'unified diff. Call this first to see what the change does. Large diffs are truncated with a ' +
      'marker; noise files (lockfiles, minified assets, generated code) are replaced with per-file ' +
      'markers.',
    input: v.object({
      owner: v.string(),
      repo: v.string(),
      number: v.number(),
    }),
    async run({ data }) {
      assertCrPinned(pin, data.owner, data.repo);
      const { cr } = await pinnedCr(pin);
      const comments = await listCrComments(cr.id);
      const summary = comments.find((c) => c.kind === 'summary' && c.author === CR_BOT_AUTHOR);
      const diff = await getCrDiffPatch(cr);
      const files = parseCrFiles(cr);
      return {
        output: {
          title: cr.title,
          body: summary?.body ?? '',
          author: cr.opened_by,
          baseRef: cr.target_branch,
          headRef: cr.source_branch,
          headSha: cr.source_head ?? '',
          draft: false,
          changedFiles: files.length,
          additions: files.reduce((sum, f) => sum + (f.additions ?? 0), 0),
          deletions: files.reduce((sum, f) => sum + (f.deletions ?? 0), 0),
          diff: truncate(filterDiffNoise(diff), MAX_DIFF_CHARS, 'diff'),
        },
      };
    },
  });

export const makeFetchCrFile = (pin: CrPin) =>
  defineTool({
    name: 'fetch_file',
    description:
      'Fetch the full contents of one file from the repository at a given ref (branch or commit SHA). ' +
      'Use this when the diff alone lacks context — e.g. to see the whole function or module a hunk touches. ' +
      'Use the headSha to read the changed version, or the base branch name for the original.',
    input: v.object({
      owner: v.string(),
      repo: v.string(),
      path: v.string(),
      ref: v.string(),
    }),
    async run({ data }) {
      assertCrPinned(pin, data.owner, data.repo);
      const { repo } = await pinnedCr(pin);
      // Artifacts has no contents API; the CR engine keeps a synced clone in
      // the per-repo sandbox, so file reads are `git show ref:path` there.
      // Ref and path travel via env — never interpolated into the command.
      const sandbox = generationSandbox(repo);
      if (!CR_BRANCH_NAME.test(data.ref)) throw new Error(`unusable ref ${data.ref}`);
      const result = await sandbox.exec(
        `git -C ${CR_DIR} show "$CR_REF:$CR_PATH" 2>/dev/null || ` +
          `git -C ${CR_DIR} show "refs/remotes/origin/$CR_REF:$CR_PATH"`,
        { env: { CR_REF: data.ref, CR_PATH: data.path }, timeout: 60_000 },
      );
      if (!result.success) {
        throw new Error(
          `could not read ${data.path} at ${data.ref} — the file may not exist at that ref; ` +
            'rely on the diff context instead',
        );
      }
      return { output: truncate(result.stdout, MAX_FILE_CHARS, `file ${data.path}`) };
    },
  });

export const makeFetchCrComments = (pin: CrPin) =>
  defineTool({
    name: 'fetch_review_threads',
    description:
      'Fetch existing review state on this change request: prior review summaries and every ' +
      'line-anchored finding or comment. Use this on re-reviews to reconcile against earlier ' +
      'feedback instead of repeating it.',
    input: v.object({
      owner: v.string(),
      repo: v.string(),
      number: v.number(),
    }),
    async run({ data }) {
      assertCrPinned(pin, data.owner, data.repo);
      const { cr } = await pinnedCr(pin);
      const comments = await listCrComments(cr.id);
      return {
        output: {
          reviews: comments
            .filter((c) => c.kind === 'summary')
            .map((c) => ({
              author: c.author,
              state: cr.review_status === 'changes_requested' ? 'CHANGES_REQUESTED' : 'APPROVED',
              submittedAt: c.created_at,
              body: c.body.slice(0, 2_000),
            })),
          threads: comments
            .filter((c) => c.kind === 'finding' || (c.kind === 'comment' && c.file))
            .map((c) => ({
              path: c.file,
              line: c.line,
              resolved: false,
              outdated: false,
              comments: [
                { author: c.author, createdAt: c.created_at, body: c.body.slice(0, 2_000) },
              ],
            })),
        },
      };
    },
  });

// The native post_review: findings land as cr_comments, the verdict on the
// CR row and its 'review' check, and the D1 review row completes — then the
// auto-merge gate gets its chance, exactly like the GitHub tool's tail.
export const makePostCrReview = (agentInstanceId: string, pin: CrPin) =>
  defineTool({
    name: 'post_review',
    description:
      'Post the finished review to the change request: a short summary body plus inline comments ' +
      'anchored to specific lines of the diff. Call this exactly once per review request (a re-review ' +
      'posts a new review). Each comment must anchor to a line that is part of the diff (side RIGHT ' +
      'with new-file line numbers). Findings about code outside the diff belong in the summary body.',
    input: v.object({
      owner: v.string(),
      repo: v.string(),
      number: v.number(),
      body: v.pipe(v.string(), v.minLength(1)),
      findings: v.optional(v.array(findingSchema), []),
    }),
    async run({ data }) {
      assertCrPinned(pin, data.owner, data.repo);
      const { cr, repo } = await pinnedCr(pin);
      for (const finding of data.findings) {
        await addCrComment({
          changeRequestId: cr.id,
          file: finding.path,
          line: finding.line,
          author: CR_BOT_AUTHOR,
          kind: 'finding',
          severity: findingSeverity(finding),
          body: finding.body,
        });
      }
      await addCrComment({
        changeRequestId: cr.id,
        file: null,
        line: null,
        author: CR_BOT_AUTHOR,
        kind: 'summary',
        severity: null,
        body: data.body,
      });
      // Same verdict mapping as the GitHub tool: a P1 requests changes in
      // blocking mode; otherwise the review approves.
      const hasP1 = data.findings.map(findingSeverity).includes('P1');
      const blocking = repo.blocking_reviews === 1 && hasP1;
      await setChangeRequestReviewStatus(cr.id, blocking ? 'changes_requested' : 'approved');
      await upsertCrCheck(
        cr.id,
        'review',
        blocking ? 'failed' : 'passed',
        `${data.findings.length} finding(s)` + (blocking ? ' — P1 blocks merge' : ''),
      );
      const url = cr.feature_id ? cockpitFeatureUrl(cr.feature_id) : null;
      await completeReview(agentInstanceId, url, data.findings.length);
      if (blocking && repo.auto_fix === 1) {
        // Native verdicts fire no webhook, so the blocking-review fix
        // dispatch happens here (the consumer re-validates toggle and cap).
        await enqueueFactoryMessage({
          kind: 'fix',
          repoId: repo.id,
          prNumber: cr.number,
          trigger: 'blocking_review',
        });
      }
      if (!blocking) await maybeAutoMergeCr(repo, cr.id);
      return { output: { posted: true, inline: data.findings.length, url, fallback: null } };
    },
  });
