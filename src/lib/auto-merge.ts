import { env } from 'cloudflare:workers';
import { gh } from '../tools/github.ts';
import {
	getFeatureByRepoPr,
	latestVerificationForFeature,
	type RepositoryRow,
} from './db.ts';
import { installationToken } from './github-app.ts';

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
	// Auto-merge is only meaningful when the review gate exists at all.
	if (repo.auto_merge !== 1 || repo.blocking_reviews !== 1) return;
	const label = `${repo.owner}/${repo.name}#${prNumber}`;
	try {
		const feature = await getFeatureByRepoPr(repo.id, prNumber);
		if (!feature || !feature.acceptance) return; // not a factory PR / nothing verified

		const verification = await latestVerificationForFeature(feature.id);
		if (verification?.status !== 'passed') {
			console.log(`turbodiff: auto-merge waiting on verification for ${label}`);
			return;
		}

		const token = await installationToken(repo.installation_id);
		const reviews = (await (
			await gh(token, `/repos/${repo.owner}/${repo.name}/pulls/${prNumber}/reviews?per_page=100`)
		).json()) as { state: string; body: string; user: { type: string; login: string } | null }[];
		// Only turbodiff's own reviews satisfy the gate — another bot's APPROVE
		// (CodeRabbit, Copilot, …) must not stand in for our review having run.
		const ourLogin = `${env.GITHUB_APP_SLUG || 'turbodiff'}[bot]`;
		const botReviews = reviews.filter((r) => r.user?.type === 'Bot' && r.user.login === ourLogin);
		if (botReviews.length === 0) {
			console.log(`turbodiff: auto-merge waiting on review for ${label}`);
			return;
		}
		// Conservative: ANY blocking-intent review — even one later superseded by
		// a clean re-review — declines the auto-merge in favor of a human look.
		const anyBlocking = botReviews.some(
			(r) =>
				r.state === 'CHANGES_REQUESTED' ||
				(r.state === 'COMMENTED' && r.body.startsWith('**Verdict: REQUEST_CHANGES**')),
		);
		if (anyBlocking) {
			console.log(`turbodiff: auto-merge declined for ${label} (a review requested changes)`);
			return;
		}

		const res = await gh(token, `/repos/${repo.owner}/${repo.name}/pulls/${prNumber}/merge`, {
			method: 'PUT',
			body: JSON.stringify({ merge_method: 'merge' }),
		});
		const merged = (await res.json()) as { merged?: boolean; sha?: string };
		if (!merged.merged) throw new Error('merge endpoint returned merged=false');
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
	}
}
