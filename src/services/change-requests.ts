import { env } from 'cloudflare:workers';
import { computeCrState, mergeCr } from '../ai/runtime/cr-engine.ts';
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
  markChangeRequestMerged,
  updateChangeRequestState,
  updateFeature,
  upsertCrCheck,
  type ChangeRequestRow,
  type RepositoryRow,
} from '../data/db.ts';
import { enqueueFactoryMessage } from './factory-queue.ts';

// Native change-request orchestration (docs/artifacts-provider.md): the
// forge layer for Artifacts-hosted repos. Rows in D1 (data/change-requests),
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
    filesJson: JSON.stringify(state.files),
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
  await enqueueFactoryMessage({ kind: 'cr_review', changeRequestId: cr.id });
  return refreshed;
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

// Native auto-merge, mirroring services/auto-merge.ts gates on native data:
// opted in, review approved, all checks green, verification passed when the
// feature has acceptance criteria, and a clean dry-run. Failures log rather
// than throw — auto-merge is a convenience, never a crash.
export async function maybeAutoMergeCr(
  repo: RepositoryRow,
  changeRequestId: number,
): Promise<void> {
  if (repo.auto_merge !== 1) return;
  const cr = await getChangeRequest(changeRequestId);
  if (!cr || cr.status !== 'open') return;
  if (cr.review_status !== 'approved' || cr.mergeable !== 1) return;
  const checks = await listCrChecks(cr.id);
  if (checks.some((check) => check.status !== 'passed')) return;
  if (cr.feature_id) {
    const feature = await getFeature(cr.feature_id);
    if (feature?.acceptance) {
      const verification = await latestVerificationForFeature(cr.feature_id);
      if (verification?.status !== 'passed') return;
    }
  }
  try {
    await mergeNativeChangeRequest(cr.id, 'auto-merge');
  } catch (err) {
    console.error(`turbodiff: auto-merge of CR ${cr.id} failed:`, err);
  }
}

export interface CrFilePatch {
  path: string;
  patch: string;
}

// Splits a unified diff into per-file patches — the shape the cockpit's
// @pierre/diffs viewer consumes (the GitHub path builds the same thing from
// /pulls/:n/files).
export function splitPatchByFile(patch: string): CrFilePatch[] {
  return patch
    .split(/\n(?=diff --git )/)
    .filter((section) => section.trim())
    .map((section) => {
      const lines = section.split('\n');
      let oldPath = '';
      let newPath = '';
      for (const line of lines.slice(0, 6)) {
        if (line.startsWith('--- ')) oldPath = line.slice(4);
        if (line.startsWith('+++ ')) newPath = line.slice(4);
      }
      const path =
        newPath && newPath !== '/dev/null'
          ? newPath.replace(/^b\//, '')
          : oldPath.replace(/^a\//, '');
      return { path, patch: section.endsWith('\n') ? section : `${section}\n` };
    })
    .filter((file) => file.path);
}
