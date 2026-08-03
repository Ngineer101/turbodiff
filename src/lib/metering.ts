import { observe } from '@flue/runtime';
import { addReviewUsage, markReviewFailed } from './db.ts';

// Meters model usage per review. Every completed model call emits a `turn`
// event carrying provider-reported tokens and catalog-priced cost; review
// rows store their exact agent instance id (recordReview), so attribution is
// a direct match on event.instanceId — no id parsing.
//
// On Cloudflare each agent conversation runs in its own Durable Object
// isolate; this subscriber registers in every isolate and sees only that
// isolate's turns — exactly the per-review attribution we want.

export function registerReviewMetering(): void {
	observe((event) => {
		if (event.instanceId === undefined) return;
		// When the submission settles and post_review never completed the row
		// (agent error, abort, or a run that ended without posting), flip it to
		// failed so it doesn't sit "running" until the stall cutoff.
		if (event.type === 'submission_settled') {
			void markReviewFailed(event.instanceId).catch((err) =>
				console.error('turbodiff: marking review failed errored', err),
			);
			return;
		}
		if (event.type !== 'turn' || !event.response.usage) return;
		const { usage } = event.response;
		// Subscribers run synchronously on the emission path — queue the D1
		// write and contain failures; metering must never affect the agent.
		void addReviewUsage(event.instanceId, {
			inputTokens: usage.input,
			outputTokens: usage.output,
			cacheReadTokens: usage.cacheRead,
			cacheWriteTokens: usage.cacheWrite,
			costUsd: usage.cost.total,
			model: event.request.requestedModel,
		}).catch((err) => console.error('turbodiff: usage metering write failed', err));
	});
}
