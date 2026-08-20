import { githubRequest as gh } from '../integrations/github/client.ts';
import {
  getFeatureByRepoPr,
  listOpenFactoryPrConflictCandidates,
  type RepositoryRow,
} from '../data/db.ts';
import { installationToken } from '../integrations/github/app.ts';
import type { ConflictResolveQueueMessage } from '../shared/factory-messages.ts';
import { enqueueFactoryMessage } from './factory-queue.ts';

// Shared "detect + notify + dispatch" helpers for merge conflicts on factory
// PRs. Used by both merge paths (auto-merge, the cockpit Merge button), the
// completion paths (verification, review), and the scheduled sweep, so the
// conflict definition and the comment text live in exactly one place.

export interface PrMergeability {
  mergeable: boolean | null;
  mergeableState: string; // GitHub's mergeable_state: dirty | clean | unstable | blocked | behind | unknown | draft
  hasConflict: boolean; // mergeableState === 'dirty'
  baseRef: string; // the branch this PR would merge into — needed to notify/resolve
}

type PrPayload = { mergeable: boolean | null; mergeable_state: string; base: { ref: string } };

function toMergeability(pr: PrPayload): PrMergeability {
  return {
    mergeable: pr.mergeable,
    mergeableState: pr.mergeable_state,
    hasConflict: pr.mergeable_state === 'dirty',
    baseRef: pr.base.ref,
  };
}

// GitHub computes mergeable_state asynchronously — a fresh or just-updated PR
// can read 'unknown' for a while (regularly >10s after a base-branch push).
// The pre-merge-attempt call sites need a real answer, so they poll with
// backoff; the cockpit page-load read stays fast and just shows "checking…"
// for that one request.
const UNKNOWN_RETRY_DELAYS_MS = [1_500, 3_000, 5_000, 8_000];

export async function checkMergeability(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  opts?: { retryOnUnknown?: boolean },
): Promise<PrMergeability> {
  // SAFETY: gh() throws on non-2xx, and GitHub's "get a pull request" response
  // always carries mergeable (nullable), mergeable_state, and base.ref.
  const fetchPr = () =>
    gh(token, `/repos/${owner}/${repo}/pulls/${prNumber}`).then(
      (r) => r.json() as Promise<PrPayload>,
    );
  let pr = await fetchPr();
  if (opts?.retryOnUnknown) {
    for (const delayMs of UNKNOWN_RETRY_DELAYS_MS) {
      if (pr.mergeable_state !== 'unknown') break;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      pr = await fetchPr();
    }
  }
  return toMergeability(pr);
}

// Standalone conflict detection + dispatch, gated ONLY on the repo's
// auto_resolve_conflicts toggle — deliberately independent of the auto-merge
// gates (auto_merge, blocking_reviews, review history), which previously made
// the toggle dead unless auto-merge was fully configured. Callers invoke it
// wherever a factory PR may have picked up a conflict: verification/review
// completion, a failed auto-merge attempt, and the scheduled sweep. Never
// throws; never touches human-authored PRs (no feature row).
export async function maybeResolveConflict(
  repo: RepositoryRow,
  prNumber: number,
  opts?: { retryOnUnknown?: boolean },
): Promise<void> {
  if (repo.enabled !== 1) return;
  const label = `${repo.owner}/${repo.name}#${prNumber}`;
  try {
    const feature = await getFeatureByRepoPr(repo.id, prNumber);
    if (!feature) return;
    const token = await installationToken(repo.installation_id);
    const mergeability = await checkMergeability(token, repo.owner, repo.name, prNumber, {
      retryOnUnknown: opts?.retryOnUnknown ?? true,
    });
    if (!mergeability.hasConflict) return;
    if (repo.auto_resolve_conflicts === 1) {
      const msg: ConflictResolveQueueMessage = {
        kind: 'resolve_conflict',
        repoId: repo.id,
        prNumber,
      };
      await enqueueFactoryMessage(msg);
      console.log(`turbodiff: conflict detected on ${label}, resolution enqueued`);
    } else {
      await postConflictCommentIfAbsent(
        token,
        repo.owner,
        repo.name,
        prNumber,
        mergeability.baseRef,
      );
      console.log(`turbodiff: conflict detected on ${label} (auto-resolve off, notice posted)`);
    }
  } catch (err) {
    console.warn(`turbodiff: conflict check failed for ${label}:`, err);
  }
}

// Cron-driven safety net: the event-driven call sites only run when
// turbodiff itself acts on a PR, but the typical conflict appears when an
// unrelated PR merges into the base branch — which fires no event this app
// receives. The sweep bounds detection latency to one cron interval. Skips
// the 'unknown' backoff (a PR that reads unknown is retried next tick).
export async function sweepFactoryPrConflicts(): Promise<void> {
  const candidates = await listOpenFactoryPrConflictCandidates();
  for (const { repo, prNumber } of candidates) {
    await maybeResolveConflict(repo, prNumber, { retryOnUnknown: false });
  }
}

const CONFLICT_MARKER = '<!-- turbodiff:conflict-notice -->';

// Posts a conflict notice unless one is already on the PR — a conflict that
// persists across several verification/review cycles (maybeAutoMerge re-runs
// on every completion) must not spam the PR every time.
export async function postConflictCommentIfAbsent(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  baseRef: string,
): Promise<void> {
  // SAFETY: gh() throws on non-2xx, and GitHub's "list issue comments" response
  // is an array whose items always carry a string body.
  const comments = (await (
    await gh(token, `/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`)
  ).json()) as { body: string }[];
  if (comments.some((c) => c.body.includes(CONFLICT_MARKER))) return;

  await gh(token, `/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
    method: 'POST',
    body: JSON.stringify({
      body:
        `${CONFLICT_MARKER}\n⚠️ **Merge conflict detected** — this pull request can't be merged ` +
        `cleanly into \`${baseRef}\`. Rebase or merge \`${baseRef}\` into this branch and push ` +
        `to resolve it before it can be merged.`,
    }),
  });
}

// Posted once a conflict-resolution merge commit has been pushed. Flags the
// risk explicitly: a merge commit's conflict resolution picked between
// divergent code and may not read as an obviously-reviewable diff.
export async function postConflictResolvedComment(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  commitSha: string,
): Promise<void> {
  await gh(token, `/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
    method: 'POST',
    body: JSON.stringify({
      body:
        `🔀 **Turbodiff auto-resolved a merge conflict**, pushing ${commitSha} — the fix agent ` +
        `picked between divergent code on both sides of the conflict, so this merge commit may ` +
        `not read as an obviously-reviewable diff. Re-verification is queued; please give the ` +
        `conflicting files a look before merging.`,
    }),
  });
}
