import { observe } from '@flue/runtime';
import { addReviewUsage, markReviewFailed } from './db.ts';

// Meters model usage per review. Every completed model call emits a `turn`
// event carrying provider-reported tokens and catalog-priced cost; we
// attribute it to the review row via the agent instance id and accumulate
// in D1 (columns added in migrations/0003_review_usage.sql).
//
// On Cloudflare each agent conversation runs in its own Durable Object
// isolate; this subscriber registers in every isolate and sees only that
// isolate's turns — exactly the per-PR attribution we want.

// Instance ids are `${owner}--${repo}--${number}` lowercased (dispatchReview
// in app.ts). GitHub logins can't contain '--', so the first separator ends
// the owner; repo names can, so the middle keeps any remaining separators.
function parseInstanceId(id: string): { owner: string; repo: string; pr: number } | null {
	const parts = id.split('--');
	if (parts.length < 3) return null;
	const pr = Number(parts[parts.length - 1]);
	if (!Number.isInteger(pr) || pr < 1) return null;
	return { owner: parts[0], repo: parts.slice(1, -1).join('--'), pr };
}

export function registerReviewMetering(): void {
	observe((event) => {
		if (event.instanceId === undefined) return;
		// When the submission settles and post_review never completed the row
		// (agent error, abort, or a run that ended without posting), flip it to
		// failed so it doesn't sit "running" until the stall cutoff.
		if (event.type === 'submission_settled') {
			const target = parseInstanceId(event.instanceId);
			if (!target) return;
			void markReviewFailed(target.owner, target.repo, target.pr).catch((err) =>
				console.error('turbodiff: marking review failed errored', err),
			);
			return;
		}
		if (event.type !== 'turn' || !event.response.usage) return;
		const target = parseInstanceId(event.instanceId);
		if (!target) return;
		const { usage } = event.response;
		// Subscribers run synchronously on the emission path — queue the D1
		// write and contain failures; metering must never affect the agent.
		void addReviewUsage(target.owner, target.repo, target.pr, {
			inputTokens: usage.input,
			outputTokens: usage.output,
			cacheReadTokens: usage.cacheRead,
			cacheWriteTokens: usage.cacheWrite,
			costUsd: usage.cost.total,
			model: event.request.requestedModel,
		}).catch((err) => console.error('turbodiff: usage metering write failed', err));
	});
}
