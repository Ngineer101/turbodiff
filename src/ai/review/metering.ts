import { observe } from '@flue/runtime';
import { addReviewUsage } from '../../data/db.ts';
import { isExplainInstanceId } from '../../domain/explain.ts';
import { failLifecycleReview } from '../../services/lifecycle.ts';

// Meters model usage per review. Every completed model call emits a `turn`
// event carrying provider-reported tokens and catalog-priced cost; review
// rows store their exact agent instance id (tryRecordReview), so attribution
// is a direct match on event.instanceId — no id parsing.
//
// On Cloudflare each agent conversation runs in its own Durable Object
// isolate; this subscriber registers in every isolate and sees only that
// isolate's turns — exactly the per-review attribution we want.

// The settlement's error is the only record of why a review died — the
// review row keeps it so the failure is diagnosable from the product.
export function settlementReason(event: {
  outcome: 'completed' | 'failed' | 'aborted';
  error?: { name?: string; message: string; type?: string; details?: string };
}): string {
  if (event.outcome === 'completed') return 'agent run ended without posting a review';
  const error = event.error;
  if (!error) return `agent run ${event.outcome}`;
  const head = [error.type ?? error.name, error.message].filter(Boolean).join(': ');
  return `${event.outcome}: ${head}${error.details ? ` — ${error.details}` : ''}`.slice(0, 1_000);
}

export function registerReviewMetering(): void {
  observe((event) => {
    // Explain runs share the isolate's event stream but own their rows
    // (src/ai/explain/metering.ts).
    if (event.instanceId === undefined || isExplainInstanceId(event.instanceId)) return;
    // When the submission settles and post_review never completed the row
    // (agent error, abort, or a run that ended without posting), flip it to
    // failed so it doesn't sit "running" until the stall cutoff.
    if (event.type === 'submission_settled') {
      void failLifecycleReview(event.instanceId, settlementReason(event)).catch((err) =>
        console.error('turbodiff: marking review failed errored', err),
      );
      return;
    }
    if (event.type !== 'turn' || !event.response.usage) return;
    const { usage } = event.response;
    // Subscribers run synchronously on the emission path — queue the PostgreSQL
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
