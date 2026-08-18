import { gh } from '../tools/github.ts';

// Shared "detect + notify" helper for merge conflicts on factory PRs. Used by
// both merge paths (auto-merge, the cockpit Merge button) and the cockpit
// read path (GET /factory/features/:id), so the conflict definition and the
// comment text live in exactly one place.

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
// can read 'unknown' for a moment. The pre-merge-attempt call sites need a
// real answer, so they retry once after a short wait; the cockpit page-load
// read stays fast and just shows "checking…" for that one request.
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
  if (pr.mergeable_state === 'unknown' && opts?.retryOnUnknown) {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    pr = await fetchPr();
  }
  return toMergeability(pr);
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
