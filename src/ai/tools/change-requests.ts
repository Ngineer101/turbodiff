import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import {
  addCrComment,
  getChangeRequest,
  getRepoByFullName,
  getReviewRunGuard,
  listReviewFileEvidence,
  listCrComments,
  recordReviewFileAcknowledgements,
  recordReviewPatchChunkDelivery,
  recordReviewPatchDelivery,
  setChangeRequestReviewStatus,
  upsertCrCheck,
  type ChangeRequestRow,
  type RepositoryRow,
} from '../../data/db.ts';
import { completeLifecycleReviewById } from '../../services/lifecycle.ts';
import {
  CR_BOT_AUTHOR,
  getCrDiffPatch,
  maybeAutoMergeCr,
  changeRequestFiles,
} from '../../services/change-requests.ts';
import { CR_BRANCH_NAME, CR_DIR } from '../runtime/cr-engine.ts';
import { enqueueFactoryMessage } from '../../services/factory-queue.ts';
import { generationSandbox } from '../runtime/sandbox.ts';
import { cockpitFeatureUrl } from '../../services/urls.ts';
import {
  assertPinned,
  findingSchema,
  MAX_DIFF_CHARS,
  MAX_FILE_CHARS,
  reviewFileEvidenceSchema,
  truncate,
} from './github.ts';
import { findingSeverity } from '../../domain/review-findings.ts';
import {
  buildReviewDiffSnapshot,
  missingReviewFiles,
  reviewConclusion,
  reviewDiffOmissionReason,
} from '../../domain/review-context.ts';
import { splitDiffSegmentChunks, splitDiffSegments } from '../../domain/review-diff.ts';

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
  reviewId: number;
  expectedHeadSha: string;
}

function assertCrPinned(pin: CrPin, owner: string, repo: string, number?: number): void {
  assertPinned({ owner: pin.owner, repo: pin.repo }, owner, repo);
  if (number !== undefined && number !== pin.number) {
    throw new Error(`this review is scoped to change request #${pin.number}`);
  }
}

async function pinnedCr(
  pin: CrPin,
  allowStale = false,
): Promise<{ cr: ChangeRequestRow; repo: RepositoryRow }> {
  const cr = await getChangeRequest(pin.changeRequestId);
  if (!cr) throw new Error(`change request ${pin.changeRequestId} no longer exists`);
  const repo = await getRepoByFullName(pin.owner, pin.repo);
  if (!repo || repo.id !== cr.repository_id) {
    throw new Error(
      `change request ${pin.changeRequestId} does not belong to ${pin.owner}/${pin.repo}`,
    );
  }
  if (!allowStale && cr.source_head !== pin.expectedHeadSha) {
    throw new Error(
      `change request head changed from ${pin.expectedHeadSha} to ${cr.source_head ?? 'unknown'}; this review is stale`,
    );
  }
  return { cr, repo };
}

export const makeFetchCr = (pin: CrPin, maxChars = MAX_DIFF_CHARS) =>
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
      assertCrPinned(pin, data.owner, data.repo, data.number);
      const { cr } = await pinnedCr(pin);
      const comments = await listCrComments(cr.id);
      const summary = comments.find((c) => c.kind === 'summary' && c.author === CR_BOT_AUTHOR);
      const diff = await getCrDiffPatch(cr);
      const files = changeRequestFiles(cr);
      const snapshot = buildReviewDiffSnapshot(diff, maxChars);
      await recordReviewPatchDelivery(pin.reviewId, snapshot.includedFiles);
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
          diff: snapshot.diff,
          files: snapshot.files.map((file) => ({
            path: file.path,
            chars: file.chars,
            reviewable: file.reviewable,
            omittedReason: file.omittedReason,
            included: file.included,
          })),
          includedFiles: snapshot.includedFiles,
          remainingFiles: snapshot.remainingFiles,
          coverageComplete: snapshot.complete,
        },
      };
    },
  });

export const makeFetchCrDiff = (pin: CrPin, maxChars = MAX_DIFF_CHARS) =>
  defineTool({
    name: 'fetch_diff',
    description:
      'Fetch one deterministic page of a reviewable patch omitted from fetch_pr. Start at chunk 0 ' +
      'and request nextChunk until it is null.',
    input: v.object({
      owner: v.string(),
      repo: v.string(),
      number: v.number(),
      path: v.pipe(v.string(), v.minLength(1), v.maxLength(1_000)),
      chunk: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 0),
    }),
    async run({ data }) {
      assertCrPinned(pin, data.owner, data.repo, data.number);
      const { cr } = await pinnedCr(pin);
      const diff = await getCrDiffPatch(cr);
      const selected = splitDiffSegments(diff).find((entry) => entry.path === data.path);
      if (!selected) throw new Error(`changed path ${data.path} was not found in the current diff`);
      const omittedReason = reviewDiffOmissionReason(selected.path, selected.segment);
      if (omittedReason) {
        throw new Error(`changed path ${data.path} is not reviewable: ${omittedReason}`);
      }
      const chunks = splitDiffSegmentChunks(selected.segment, maxChars);
      if (data.chunk >= chunks.length) {
        throw new Error(`chunk ${data.chunk} is outside the 0-${chunks.length - 1} range`);
      }
      await recordReviewPatchChunkDelivery(pin.reviewId, selected.path, data.chunk, chunks.length);
      const nextChunk = data.chunk + 1 < chunks.length ? data.chunk + 1 : null;
      return {
        output: {
          path: selected.path,
          diff: chunks[data.chunk],
          chunk: data.chunk,
          chunkCount: chunks.length,
          nextChunk,
          complete: nextChunk === null,
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
      assertCrPinned(pin, data.owner, data.repo, data.number);
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
// CR row and its 'review' check, and the PostgreSQL review row completes — then the
// auto-merge gate gets its chance, exactly like the GitHub tool's tail.
export const makePostCrReview = (pin: CrPin) =>
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
      fileEvidence: v.optional(v.array(reviewFileEvidenceSchema), []),
    }),
    async run({ data }) {
      assertCrPinned(pin, data.owner, data.repo, data.number);
      const { cr, repo } = await pinnedCr(pin, true);
      const guard = await getReviewRunGuard(pin.reviewId);
      if (
        !guard ||
        guard.status !== 'running' ||
        guard.repository_id !== repo.id ||
        guard.pr_number !== pin.number ||
        guard.head_sha !== pin.expectedHeadSha
      ) {
        return {
          output: {
            posted: false,
            stale: true,
            reason: 'the exact review run is no longer active',
            inline: 0,
            url: null,
            fallback: null,
          },
        };
      }
      const liveDiff = await getCrDiffPatch(cr);
      const manifest = buildReviewDiffSnapshot(liveDiff, 0).files;
      if (cr.source_head !== pin.expectedHeadSha) {
        const reviewablePaths = manifest.filter((file) => file.reviewable).map((file) => file.path);
        await completeLifecycleReviewById(pin.reviewId, null, 0, 'comment', [], undefined, {
          conclusion: 'inconclusive',
          coverageStatus: 'stale',
          reviewableFileCount: reviewablePaths.length,
          coveredFileCount: 0,
          missingPaths: reviewablePaths,
          coverageHeadSha: pin.expectedHeadSha,
          publishedHeadSha: null,
        });
        return {
          output: {
            posted: false,
            stale: true,
            reason: `change request head changed to ${cr.source_head ?? 'unknown'}`,
            inline: 0,
            url: null,
            fallback: null,
          },
        };
      }
      const reviewablePaths = new Set(
        manifest.filter((file) => file.reviewable).map((file) => file.path),
      );
      const submittedEvidence = data.fileEvidence.filter((item) => reviewablePaths.has(item.path));
      await recordReviewFileAcknowledgements(pin.reviewId, submittedEvidence);
      const evidence = await listReviewFileEvidence(pin.reviewId);
      const coveredPaths = evidence
        .filter((item) => item.patch_delivered && item.disposition === 'reviewed')
        .map((item) => item.path);
      const blockedEvidence = evidence
        .filter((item) => item.disposition === 'blocked' && item.evidence)
        .map((item) => ({ path: item.path, evidence: item.evidence! }));
      const missingFiles = missingReviewFiles(manifest, coveredPaths);
      const reviewableFileCount = manifest.filter((file) => file.reviewable).length;
      const hasP1 = data.findings.map(findingSeverity).includes('P1');
      const hasP2 = data.findings.map(findingSeverity).includes('P2');
      const coverageComplete = missingFiles.length === 0;
      const conclusion = reviewConclusion(hasP1, hasP2, coverageComplete);
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
      const coverageNote = coverageComplete
        ? ''
        : `\n\n_Coverage incomplete: ${reviewableFileCount - missingFiles.length}/${reviewableFileCount} ` +
          `reviewable file patch(es) were delivered and acknowledged. Missing: ${missingFiles
            .slice(0, 20)
            .map((path) => `\`${path}\``)
            .join(
              ', ',
            )}${missingFiles.length > 20 ? `, and ${missingFiles.length - 20} more` : ''}. ` +
          'This review is inconclusive.';
      const blockedNote =
        blockedEvidence.length === 0
          ? ''
          : '\n\nBlocked-file evidence:\n' +
            blockedEvidence
              .slice(0, 20)
              .map((item) => `- \`${item.path}\`: ${item.evidence}`)
              .join('\n');
      await addCrComment({
        changeRequestId: cr.id,
        file: null,
        line: null,
        author: CR_BOT_AUTHOR,
        kind: 'summary',
        severity: null,
        body: `${data.body}${coverageNote}${blockedNote}`,
      });
      // Same verdict mapping as the GitHub tool: a P1 requests changes in
      // blocking mode; otherwise the review approves.
      const blocking = repo.blocking_reviews && hasP1;
      await setChangeRequestReviewStatus(cr.id, blocking ? 'changes_requested' : 'approved');
      await upsertCrCheck(
        cr.id,
        'review',
        blocking || conclusion === 'inconclusive' ? 'failed' : 'passed',
        conclusion === 'inconclusive'
          ? `inconclusive — ${missingFiles.length} reviewable file(s) missing`
          : `${data.findings.length} finding(s)` + (blocking ? ' — P1 blocks merge' : ''),
      );
      const url = cr.feature_id ? cockpitFeatureUrl(cr.feature_id) : null;
      await completeLifecycleReviewById(
        pin.reviewId,
        url,
        data.findings.length,
        (hasP1 && repo.process_profile !== 'legacy_factory') || blocking
          ? 'request_changes'
          : 'approve',
        [...new Set(data.findings.map((finding) => finding.path))],
        undefined,
        {
          conclusion,
          coverageStatus: coverageComplete ? 'complete' : 'incomplete',
          reviewableFileCount,
          coveredFileCount: reviewableFileCount - missingFiles.length,
          missingPaths: missingFiles,
          coverageHeadSha: cr.source_head,
          publishedHeadSha: cr.source_head,
        },
      );
      if (blocking && repo.auto_fix && repo.process_profile === 'legacy_factory') {
        // Native verdicts fire no webhook, so the blocking-review fix
        // dispatch happens here (the consumer re-validates toggle and cap).
        await enqueueFactoryMessage({
          kind: 'fix',
          repoId: repo.id,
          prNumber: cr.number,
          trigger: 'blocking_review',
        });
      }
      if (!blocking && conclusion !== 'inconclusive') await maybeAutoMergeCr(repo, cr.id);
      return {
        output: {
          posted: true,
          stale: false,
          reason: null,
          inline: data.findings.length,
          url,
          fallback: null,
        },
      };
    },
  });
