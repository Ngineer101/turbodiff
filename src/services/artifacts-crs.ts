import { env } from 'cloudflare:workers';
import {
  CR_BRANCH_NAME,
  CR_REPO_NAME,
  computeCrState,
  mergeCr,
  type CrFileChange,
  type CrTiming,
} from '../ai/runners/artifacts-cr-engine.ts';
import type { ArtifactsQueueEvent } from '../shared/artifacts-events.ts';
import { isJsonObject, isString } from '../shared/json.ts';

// Phase-0.5 native change-request records (docs/artifacts-cr-spike.md): the
// forge layer GitHub normally provides, prototyped over a bare Artifacts
// remote. Stored as JSON in the R2 evidence bucket like the phase-0 event
// capture — no D1 migration for a throwaway; production CRs are D1 rows.
// Objects stay private: no capability signature is issued for this prefix.

const CRS_PREFIX = 'artifacts-spike/crs/';
const CR_ID = /^cr-[a-f0-9]{8}$/;

export interface CrComment {
  id: string;
  file: string;
  // Line number on the new side of the diff, like review comments today.
  line: number;
  author: string;
  body: string;
  createdAt: string;
}

export interface ChangeRequest {
  id: string;
  repo: string;
  title: string;
  sourceBranch: string;
  targetBranch: string;
  status: 'open' | 'merged';
  openedBy: 'demo' | 'operator' | 'push-event';
  sourceHead: string;
  targetHead: string;
  mergeBase: string;
  mergeable: boolean;
  conflictFiles: string[];
  files: CrFileChange[];
  patch: string;
  patchTruncated: boolean;
  comments: CrComment[];
  history: { at: string; what: string }[];
  // Engine timings from the most recent computation — the spike's latency data.
  timings: CrTiming[];
  createdAt: string;
  updatedAt: string;
}

function crKey(id: string): string {
  return `${CRS_PREFIX}${id}.json`;
}

async function putChangeRequest(cr: ChangeRequest): Promise<void> {
  await env.ARTIFACTS.put(crKey(cr.id), JSON.stringify(cr, null, 2), {
    httpMetadata: { contentType: 'application/json' },
  });
}

export async function getChangeRequest(id: string): Promise<ChangeRequest | null> {
  if (!CR_ID.test(id)) return null;
  const stored = await env.ARTIFACTS.get(crKey(id));
  if (!stored) return null;
  // Objects under this prefix are only ever written by putChangeRequest
  // above, so the typed read is trustworthy.
  return await stored.json<ChangeRequest>();
}

export async function listChangeRequests(repo?: string): Promise<ChangeRequest[]> {
  const listing = await env.ARTIFACTS.list({ prefix: CRS_PREFIX, limit: 100 });
  const crs: ChangeRequest[] = [];
  for (const object of listing.objects) {
    const stored = await env.ARTIFACTS.get(object.key);
    if (!stored) continue;
    // Same single-writer prefix as getChangeRequest.
    const cr = await stored.json<ChangeRequest>();
    if (!repo || cr.repo === repo) crs.push(cr);
  }
  return crs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function recompute(cr: ChangeRequest, note: string): Promise<ChangeRequest> {
  const state = await computeCrState(cr.repo, cr.sourceBranch, cr.targetBranch);
  const now = new Date().toISOString();
  const updated: ChangeRequest = {
    ...cr,
    ...state,
    history: [...cr.history, { at: now, what: note }],
    updatedAt: now,
  };
  await putChangeRequest(updated);
  return updated;
}

// Opening is idempotent per (repo, source, target) — a second open refreshes
// the existing CR, which is what makes push-event-driven opening safe.
export async function openChangeRequest(input: {
  repo: string;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  openedBy: ChangeRequest['openedBy'];
}): Promise<ChangeRequest> {
  const existing = (await listChangeRequests(input.repo)).find(
    (cr) =>
      cr.status === 'open' &&
      cr.sourceBranch === input.sourceBranch &&
      cr.targetBranch === input.targetBranch,
  );
  if (existing) return recompute(existing, `re-opened by ${input.openedBy}; refreshed`);

  const state = await computeCrState(input.repo, input.sourceBranch, input.targetBranch);
  const now = new Date().toISOString();
  const cr: ChangeRequest = {
    id: `cr-${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`,
    repo: input.repo,
    title: input.title,
    sourceBranch: input.sourceBranch,
    targetBranch: input.targetBranch,
    status: 'open',
    openedBy: input.openedBy,
    ...state,
    comments: [],
    history: [{ at: now, what: `opened by ${input.openedBy}` }],
    createdAt: now,
    updatedAt: now,
  };
  await putChangeRequest(cr);
  return cr;
}

export async function refreshChangeRequest(
  id: string,
  cause = 'operator',
): Promise<ChangeRequest | null> {
  const cr = await getChangeRequest(id);
  if (!cr || cr.status !== 'open') return cr;
  return recompute(cr, `refreshed (${cause})`);
}

export async function addCrComment(
  id: string,
  input: { file: string; line: number; body: string; author?: string },
): Promise<ChangeRequest | null> {
  const cr = await getChangeRequest(id);
  if (!cr) return null;
  const now = new Date().toISOString();
  const comment: CrComment = {
    id: `c-${crypto.randomUUID().slice(0, 8)}`,
    file: input.file,
    line: input.line,
    author: input.author ?? 'operator',
    body: input.body,
    createdAt: now,
  };
  const updated: ChangeRequest = {
    ...cr,
    comments: [...cr.comments, comment],
    history: [...cr.history, { at: now, what: `comment on ${input.file}:${input.line}` }],
    updatedAt: now,
  };
  await putChangeRequest(updated);
  return updated;
}

export interface MergeOutcome {
  cr: ChangeRequest;
  // Sibling open CRs recomputed because the target branch moved.
  rippled: { id: string; sourceBranch: string; mergeable: boolean; conflictFiles: string[] }[];
}

export async function mergeChangeRequest(id: string): Promise<MergeOutcome> {
  const cr = await getChangeRequest(id);
  if (!cr) throw new Error('unknown change request');
  if (cr.status !== 'open') throw new Error(`change request is ${cr.status}, not open`);

  const result = await mergeCr(
    cr.repo,
    cr.sourceBranch,
    cr.targetBranch,
    `Merge ${cr.sourceBranch} (${cr.id}): ${cr.title}`,
  );
  const now = new Date().toISOString();
  const merged: ChangeRequest = {
    ...cr,
    status: 'merged',
    targetHead: result.mergedHead,
    mergeable: true,
    conflictFiles: [],
    timings: result.timings,
    history: [...cr.history, { at: now, what: `merged as ${result.mergedHead.slice(0, 10)}` }],
    updatedAt: now,
  };
  await putChangeRequest(merged);

  // The target moved, so every sibling CR's diff and mergeability are stale —
  // recompute them now. This ripple is where the demo's second CR flips to
  // conflicted; in production the pushed event for the merge does this.
  const rippled: MergeOutcome['rippled'] = [];
  for (const sibling of await listChangeRequests(cr.repo)) {
    if (sibling.status !== 'open' || sibling.targetBranch !== cr.targetBranch) continue;
    const refreshed = await recompute(sibling, `target moved by ${cr.id} merge`);
    rippled.push({
      id: refreshed.id,
      sourceBranch: refreshed.sourceBranch,
      mergeable: refreshed.mergeable,
      conflictFiles: refreshed.conflictFiles,
    });
  }
  return { cr: merged, rippled };
}

// Queue-side hook: a push to a CR's source or target branch recomputes that
// CR — the native replacement for GitHub's PR-synchronize webhook. The beta
// payload shape is unconfirmed, so extraction is tolerant and a miss is
// logged rather than thrown (the log line is itself a spike finding).
export async function refreshCrsForPushedEvent(event: ArtifactsQueueEvent): Promise<string[]> {
  const payload = isJsonObject(event.payload) ? event.payload : null;
  const repoField = payload ? (payload.repo ?? payload.repository ?? payload.name) : null;
  const repo = isString(repoField)
    ? repoField
    : isJsonObject(repoField) && isString(repoField.name)
      ? repoField.name
      : null;
  const refField = payload ? (payload.ref ?? payload.branch) : null;
  const branch = isString(refField) ? refField.replace(/^refs\/heads\//, '') : null;
  if (!repo || !branch || !CR_REPO_NAME.test(repo) || !CR_BRANCH_NAME.test(branch)) {
    console.warn(
      'turbodiff: artifacts pushed event without usable repo/ref:',
      JSON.stringify(event).slice(0, 300),
    );
    return [];
  }

  const refreshed: string[] = [];
  for (const cr of await listChangeRequests(repo)) {
    if (cr.status !== 'open') continue;
    if (cr.sourceBranch !== branch && cr.targetBranch !== branch) continue;
    await recompute(cr, `push event on ${branch}`);
    refreshed.push(cr.id);
  }
  return refreshed;
}
