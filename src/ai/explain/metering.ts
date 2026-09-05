import { observe } from '@flue/runtime';
import { addExplanationUsage, failExplanation } from '../../data/db.ts';
import { isExplainInstanceId } from '../../domain/explain.ts';
import { settlementReason } from '../review/metering.ts';

// Explain-tab counterpart of registerReviewMetering: attributes model usage
// to the explanation row by instance id, and fails a row whose run settled
// without submit_explanation completing it (rows already 'ready' are left
// alone by failExplanation's status guard).
export function registerExplainMetering(): void {
  observe((event) => {
    if (event.instanceId === undefined || !isExplainInstanceId(event.instanceId)) return;
    if (event.type === 'submission_settled') {
      void failExplanation(event.instanceId, settlementReason(event)).catch((err) =>
        console.error('turbodiff: marking explanation failed errored', err),
      );
      return;
    }
    if (event.type !== 'turn' || !event.response.usage) return;
    const { usage } = event.response;
    void addExplanationUsage(event.instanceId, {
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadTokens: usage.cacheRead,
      cacheWriteTokens: usage.cacheWrite,
      costUsd: usage.cost.total,
      model: event.request.requestedModel,
    }).catch((err) => console.error('turbodiff: explanation metering write failed', err));
  });
}
