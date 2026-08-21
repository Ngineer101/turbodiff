import { env } from 'cloudflare:workers';
import { githubRequest as gh } from '../integrations/github/client.ts';
import {
  getFeatureByRepoPr,
  latestVerificationForFeature,
  type RepositoryRow,
} from '../data/db.ts';
import { installationToken } from '../integrations/github/app.ts';
import { checkMergeability, maybeResolveConflict } from './merge-conflicts.ts';
import { autoMergeDecline } from '../domain/merge-policy.ts';

// The one merge protocol call for factory PRs (merge_method: 'merge' is the
// factory's policy everywhere), shared by auto-merge and the cockpit Merge
// button. Throws when GitHub refuses or reports merged=false.
export async function mergePullRequest(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<{ sha?: string }> {
  const res = await gh(token, `/repos/${owner}/${repo}/pulls/${prNumber}/merge`, {
    method: 'PUT',
    body: JSON.stringify({ merge_method: 'merge' }),
  });
  // SAFETY: gh() throws on non-2xx; a 200 from GitHub's merge endpoint is a
  // JSON object, and both fields are typed optional so no shape is presumed.
  const merged = (await res.json()) as { merged?: boolean; sha?: string };
  if (!merged.merged) throw new Error('merge endpoint returned merged=false');
  return merged;
}

// Phase 5 (docs/software-factory-design.md): opt-in auto-merge for factory
// PRs. Trust is earned, not configured — even with the toggle on, a PR merges
// only when BOTH gates are green:
//   1. the latest empirical verification passed (every acceptance criterion),
//   2. at least one turbodiff review exists and NO review carries a blocking
//      verdict (state CHANGES_REQUESTED, or the self-review downgrade marker).
// Verification and review complete concurrently, so both completion paths call
// this; whichever finishes second performs the merge. On any ambiguity —
// missing review, stale block, unmergeable PR — the factory declines and
// leaves the merge to a human. Never applies to human-authored PRs (those have
// no feature row).
export async function maybeAutoMerge(repo: RepositoryRow, prNumber: number): Promise<void> {
  if (repo.auto_merge !== 1) return; // cheap pre-check before any I/O
  const label = `${repo.owner}/${repo.name}#${prNumber}`;
  try {
    const feature = await getFeatureByRepoPr(repo.id, prNumber);
    if (!feature) return; // never auto-merge human-authored PRs

    const verification = feature.acceptance ? await latestVerificationForFeature(feature.id) : null;

    const token = await installationToken(repo.installation_id);
    // SAFETY: gh() throws on non-2xx, and GitHub's "list reviews for a pull
    // request" response is an array whose items always carry string state and
    // body plus a nullable user with type and login.
    const reviews = (await (
      await gh(token, `/repos/${repo.owner}/${repo.name}/pulls/${prNumber}/reviews?per_page=100`)
    ).json()) as { state: string; body: string; user: { type: string; login: string } | null }[];
    // Only turbodiff's own reviews satisfy the gate — another bot's APPROVE
    // (CodeRabbit, Copilot, …) must not stand in for our review having run.
    const ourLogin = `${env.GITHUB_APP_SLUG || 'turbodiff'}[bot]`;
    const botReviews = reviews.filter((r) => r.user?.type === 'Bot' && r.user.login === ourLogin);
    const mergeability = await checkMergeability(token, repo.owner, repo.name, prNumber, {
      retryOnUnknown: true,
    });

    const decline = autoMergeDecline({
      optedIn: repo.auto_merge === 1,
      blockingReviews: repo.blocking_reviews === 1,
      hasAcceptanceCriteria: Boolean(feature.acceptance),
      verificationPassed: verification?.status === 'passed',
      reviewed: botReviews.length > 0,
      anyBlockingReview: botReviews.some(
        (r) =>
          r.state === 'CHANGES_REQUESTED' ||
          (r.state === 'COMMENTED' && r.body.startsWith('**Verdict: REQUEST_CHANGES**')),
      ),
      checksGreen: true, // GitHub CI signals arrive via the fix loop, not this gate
      hasConflict: mergeability.hasConflict,
    });
    if (decline) {
      console.log(`turbodiff: auto-merge declined for ${label} (${decline})`);
      if (mergeability.hasConflict) await maybeResolveConflict(repo, prNumber);
      return;
    }

    const merged = await mergePullRequest(token, repo.owner, repo.name, prNumber);
    console.log(`turbodiff: auto-merged ${label} (${merged.sha?.slice(0, 8)})`);

    await gh(token, `/repos/${repo.owner}/${repo.name}/issues/${prNumber}/comments`, {
      method: 'POST',
      body: JSON.stringify({
        body:
          '🏭 **Auto-merged by the turbodiff factory** — every acceptance criterion ' +
          'verified against the running branch and the review found no blocking issues.',
      }),
    }).catch(() => {});
  } catch (err) {
    // Failure to auto-merge is never an error state for the pipeline: the PR
    // simply stays open for a human (branch protection, conflicts, races).
    console.warn(`turbodiff: auto-merge attempt failed for ${label}:`, err);
    // A failed merge PUT is frequently a conflict that landed between the
    // mergeability check and the merge — re-check and dispatch the resolver
    // instead of going silent (maybeResolveConflict never throws).
    await maybeResolveConflict(repo, prNumber);
  }
}
