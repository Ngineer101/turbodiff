import { env } from 'cloudflare:workers';
import { githubRequest as gh } from '../../integrations/github/client.ts';
import {
  getFeatureByRepoPr,
  latestVerificationForFeature,
  reviewHeadReadiness,
  type RepositoryRow,
} from '../../data/db.ts';
import { installationToken } from '../../integrations/github/app.ts';
import { checkMergeability, maybeResolveConflict } from './merge-conflicts.ts';
import { autoMergeDecline } from '../../domain/merge-policy.ts';

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

export async function maybeAutoMerge(repo: RepositoryRow, prNumber: number): Promise<void> {
  // Composable profiles leave merge scheduling to the lifecycle coordinator.
  if (!repo.auto_merge || repo.process_profile !== 'legacy_factory') return;
  const label = `${repo.owner}/${repo.name}#${prNumber}`;
  try {
    const feature = await getFeatureByRepoPr(repo.id, prNumber);
    if (!feature) return; // never auto-merge human-authored PRs

    const verification = feature.acceptance ? await latestVerificationForFeature(feature.id) : null;

    const token = await installationToken(repo.installation_id);
    // SAFETY: GitHub's successful review-list response has this documented shape.
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
    const readiness = await reviewHeadReadiness(repo.id, prNumber, mergeability.headSha);
    const reviewEvidenceConclusive = Boolean(
      readiness &&
      readiness.stage_status === 'completed' &&
      readiness.total > 0 &&
      readiness.running === 0 &&
      readiness.failed === 0 &&
      readiness.inconclusive === 0 &&
      readiness.not_ready === 0,
    );

    const decline = autoMergeDecline({
      optedIn: repo.auto_merge,
      blockingReviews: repo.blocking_reviews,
      hasAcceptanceCriteria: Boolean(feature.acceptance),
      verificationPassed: verification?.status === 'passed',
      reviewed: botReviews.length > 0 && Boolean(readiness?.total),
      reviewEvidenceConclusive,
      anyBlockingReview: botReviews.some(
        (r) =>
          r.state === 'CHANGES_REQUESTED' ||
          (r.state === 'COMMENTED' && r.body.startsWith('**Verdict: REQUEST_CHANGES**')),
      ),
      checksGreen: mergeability.mergeableState === 'clean',
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
    console.warn(`turbodiff: auto-merge attempt failed for ${label}:`, err);
    await maybeResolveConflict(repo, prNumber);
  }
}
