import { env } from 'cloudflare:workers';
import { computeCrState, mergeCr, type CrFileChange } from '../ai/runtime/cr-engine.ts';
import {
  addCrComment,
  createChangeRequest,
  getChangeRequest,
  getFeature,
  getOpenChangeRequest,
  getRepoById,
  latestVerificationForFeature,
  listChangeRequestsForRepo,
  listCrChecks,
  listCrComments,
  markChangeRequestMerged,
  updateChangeRequestState,
  updateFeature,
  upsertCrCheck,
  type ChangeRequestRow,
  type RepositoryRow,
} from '../data/db.ts';
import { autoMergeDecline } from '../domain/merge-policy.ts';
import { splitDiffSegments } from '../domain/review-diff.ts';
import { scheduleChangeReview } from './lifecycle.ts';
import { isDeliveryProcessProfile } from '../domain/process-profiles.ts';

// Native change-request orchestration (docs/artifacts-provider.md): the
// forge layer for Artifacts-hosted repos. Rows in PostgreSQL (data/change-requests),
// git mechanics in the sandbox (ai/runtime/cr-engine), diff patches in R2
// under the private crs/ prefix — objects there are never issued capability
// signatures, so /artifacts/* cannot serve them.

export const CR_BOT_AUTHOR = 'turbodiff[bot]';

// Recomputes heads, diff, and mergeability from the live remote and persists
// the result; the patch is cached in R2 keyed by source head so a stale head
// never serves a stale diff.
export async function refreshChangeRequest(
  repo: RepositoryRow,
  cr: ChangeRequestRow,
): Promise<ChangeRequestRow> {
  const state = await computeCrState(repo, cr.source_branch, cr.target_branch);
  const diffKey = `crs/${repo.id}/${cr.id}/${state.sourceHead.slice(0, 12)}.patch`;
  await env.ARTIFACTS.put(diffKey, state.patch, {
    httpMetadata: { contentType: 'text/x-patch' },
  });
  await updateChangeRequestState(cr.id, {
    sourceHead: state.sourceHead,
    targetHead: state.targetHead,
    mergeBase: state.mergeBase,
    mergeable: state.mergeable,
    conflictFiles: state.conflictFiles,
    files: state.files,
    diffKey,
    patchTruncated: state.patchTruncated,
  });
  const updated = await getChangeRequest(cr.id);
  if (!updated) throw new Error(`change request ${cr.id} vanished during refresh`);
  return updated;
}

// Open (or refresh, when the branches already have an open CR) a native
// change request, then queue its review. `summary` becomes the CR's opening
// comment — the PR-body equivalent.
export async function openNativeChangeRequest(input: {
  repo: RepositoryRow;
  featureId: number | null;
  title: string;
  sourceBranch: string;
  targetBranch: string;
  openedBy: string;
  summary?: string;
  checkOutcome?: 'passed' | 'failed';
}): Promise<ChangeRequestRow> {
  const existing = await getOpenChangeRequest(
    input.repo.id,
    input.sourceBranch,
    input.targetBranch,
  );
  const cr =
    existing ??
    (await createChangeRequest({
      repositoryId: input.repo.id,
      featureId: input.featureId,
      title: input.title,
      sourceBranch: input.sourceBranch,
      targetBranch: input.targetBranch,
      openedBy: input.openedBy,
    }));
  if (!existing && input.summary?.trim()) {
    await addCrComment({
      changeRequestId: cr.id,
      file: null,
      line: null,
      author: CR_BOT_AUTHOR,
      kind: 'summary',
      severity: null,
      body: input.summary.trim(),
    });
  }
  if (input.checkOutcome) {
    await upsertCrCheck(
      cr.id,
      'check',
      input.checkOutcome,
      `repo check command ${input.checkOutcome}`,
    );
  }
  const refreshed = await refreshChangeRequest(input.repo, cr);
  if (refreshed.change_id && !isDeliveryProcessProfile(input.repo.process_profile)) {
    await scheduleChangeReview({
      changeId: refreshed.change_id,
      trigger: 'opened',
      actor: input.openedBy,
      idempotencyKey: `native-review:${refreshed.change_id}:opened:${refreshed.source_head ?? cr.id}`,
    });
  }
  return refreshed;
}

export function changeRequestFiles(cr: Pick<ChangeRequestRow, 'files'>): CrFileChange[] {
  return cr.files ?? [];
}

export async function getCrDiffPatch(cr: ChangeRequestRow): Promise<string> {
  if (!cr.diff_key) return '';
  const stored = await env.ARTIFACTS.get(cr.diff_key);
  return stored ? await stored.text() : '';
}

// The merge button. The engine's --no-ff merge fails on conflicts rather
// than pushing a broken tree, so a stale `mergeable` flag can't slip one
// through. After the target moves, every sibling open CR is recomputed —
// that ripple is how a second CR learns it now conflicts.
export async function mergeNativeChangeRequest(
  changeRequestId: number,
  actor: string,
): Promise<ChangeRequestRow> {
  const cr = await getChangeRequest(changeRequestId);
  if (!cr) throw new Error('unknown change request');
  if (cr.status !== 'open') throw new Error(`change request is ${cr.status}, not open`);
  const repo = await getRepoById(cr.repository_id);
  if (!repo) throw new Error('repository missing for change request');

  const result = await mergeCr(
    repo,
    cr.source_branch,
    cr.target_branch,
    `Merge ${cr.source_branch} (CR #${cr.number}): ${cr.title}`,
  );
  await markChangeRequestMerged(cr.id, result.mergedHead);
  await addCrComment({
    changeRequestId: cr.id,
    file: null,
    line: null,
    author: CR_BOT_AUTHOR,
    kind: 'comment',
    severity: null,
    body: `Merged into ${cr.target_branch} as ${result.mergedHead.slice(0, 10)} (${actor}).`,
  });
  if (cr.feature_id) await updateFeature(cr.feature_id, { status: 'merged' });

  for (const sibling of await listChangeRequestsForRepo(repo.id, 'open')) {
    if (sibling.id === cr.id || sibling.target_branch !== cr.target_branch) continue;
    await refreshChangeRequest(repo, sibling).catch((err) => {
      console.error(`turbodiff: post-merge refresh of CR ${sibling.id} failed:`, err);
    });
  }
  const merged = await getChangeRequest(cr.id);
  if (!merged) throw new Error(`change request ${cr.id} vanished after merge`);
  return merged;
}

// Native auto-merge: the same policy as the GitHub path
// (domain/merge-policy.ts), with the facts gathered from native data.
// Failures log rather than throw — auto-merge is a convenience, never a
// crash.
export async function maybeAutoMergeCr(
  repo: RepositoryRow,
  changeRequestId: number,
): Promise<void> {
  if (!repo.auto_merge || repo.process_profile !== 'legacy_factory') return;
  const cr = await getChangeRequest(changeRequestId);
  if (!cr || cr.status !== 'open') return;
  const feature = cr.feature_id ? await getFeature(cr.feature_id) : null;
  const verification = feature?.acceptance ? await latestVerificationForFeature(feature.id) : null;
  const checks = await listCrChecks(cr.id);

  const decline = autoMergeDecline({
    optedIn: repo.auto_merge,
    blockingReviews: repo.blocking_reviews,
    hasAcceptanceCriteria: Boolean(feature?.acceptance),
    verificationPassed: verification?.status === 'passed',
    reviewed: cr.review_status !== null,
    anyBlockingReview: cr.review_status === 'changes_requested',
    checksGreen: checks.length > 0 && checks.every((check) => check.status === 'passed'),
    hasConflict: cr.mergeable !== true,
  });
  if (decline) {
    console.log(`turbodiff: auto-merge declined for CR ${cr.id} (${decline})`);
    return;
  }
  try {
    await mergeNativeChangeRequest(cr.id, 'auto-merge');
  } catch (err) {
    console.error(`turbodiff: auto-merge of CR ${cr.id} failed:`, err);
  }
}

// The native counterpart of the fixer's latestBlockingFindings: the last
// review summary plus every line-anchored finding, as one markdown work
// order for the fix agent.
export async function latestNativeReviewFindings(changeRequestId: number): Promise<string | null> {
  const comments = await listCrComments(changeRequestId);
  const findings = comments.filter((comment) => comment.kind === 'finding');
  if (findings.length === 0) return null;
  const summary = comments.filter((comment) => comment.kind === 'summary').at(-1);
  const inline = findings.map(
    (f) =>
      `### ${f.file ?? 'general'}${f.line ? `:${f.line}` : ''}\n` +
      `${f.severity ? `**${f.severity}** ` : ''}${f.body}`,
  );
  return [summary?.body, ...inline].filter(Boolean).join('\n\n');
}

// Consumer-side wrapper for cockpit-initiated merges: idempotent for
// already-merged CRs, and a failure surfaces as a CR comment (the UI polls
// the CR — a silent queue failure would read as an infinite spinner).
export async function runQueuedCrMerge(changeRequestId: number, actor: string): Promise<void> {
  const cr = await getChangeRequest(changeRequestId);
  if (!cr || cr.status !== 'open') return;
  try {
    await mergeNativeChangeRequest(changeRequestId, actor);
  } catch (err) {
    console.error(`turbodiff: queued merge of CR ${changeRequestId} failed:`, err);
    await addCrComment({
      changeRequestId,
      file: null,
      line: null,
      author: CR_BOT_AUTHOR,
      kind: 'comment',
      severity: null,
      body: `Merge failed: ${err instanceof Error ? err.message.slice(0, 300) : 'unknown error'} — fix and retry from the cockpit.`,
    }).catch(() => {});
  }
}

export interface CrFilePatch {
  path: string;
  patch: string;
}

// Splits a unified diff into per-file patches — the shape the cockpit's
// @pierre/diffs viewer consumes (the GitHub path builds the same thing from
// /pulls/:n/files). File boundaries come from the shared splitter in
// domain/review-diff.ts, the same one the reviewer's noise filter uses.
export function splitPatchByFile(patch: string): CrFilePatch[] {
  return splitDiffSegments(patch).map(({ path, segment }) => ({
    path,
    patch: segment.endsWith('\n') ? segment : `${segment}\n`,
  }));
}
