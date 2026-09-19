import type { repositoryPolicy } from './repository-policy.ts';

export type DeliveryVerdict = 'passed' | 'failed' | 'inconclusive';
export type DeliveryOperation = 'review' | 'verify' | 'repair' | 'merge';
export type DeliveryDecision =
  | { kind: 'stage'; operation: DeliveryOperation; reason: string }
  | { kind: 'wait' | 'complete'; reason: string };

/** Only evidence for the current immutable revision is supplied by the coordinator. */
export function decideDelivery(input: {
  policy: ReturnType<typeof repositoryPolicy>;
  review: DeliveryVerdict | null;
  verification: DeliveryVerdict | null;
  ci: DeliveryVerdict | 'pending';
  repairAttempts: number;
  repairUnchanged: boolean;
}): DeliveryDecision {
  if (!input.policy.verify) return { kind: 'wait', reason: 'Automatic delivery is disabled.' };
  const failed =
    input.ci === 'failed' ||
    input.verification === 'failed' ||
    (input.policy.blockingReviews && input.review === 'failed');
  if (failed) {
    if (input.repairUnchanged)
      return { kind: 'wait', reason: 'Repair produced no change; human action is needed.' };
    if (input.repairAttempts >= 3)
      return { kind: 'wait', reason: 'Automatic repair limit reached (3 attempts).' };
    return {
      kind: 'stage',
      operation: 'repair',
      reason: 'Current revision has failing delivery evidence.',
    };
  }
  if (input.review === null)
    return { kind: 'stage', operation: 'review', reason: 'Review the current revision.' };
  if (input.verification === null)
    return { kind: 'stage', operation: 'verify', reason: 'Verify the acceptance contract.' };
  if (input.review === 'inconclusive' || input.verification === 'inconclusive') {
    return { kind: 'wait', reason: 'Evidence is incomplete; human action is needed.' };
  }
  if (input.ci !== 'passed')
    return { kind: 'wait', reason: 'Waiting for complete CI evidence for the current revision.' };
  return input.policy.merge
    ? { kind: 'stage', operation: 'merge', reason: 'Review, verification, and CI permit merging.' }
    : { kind: 'complete', reason: 'Ready for human merge.' };
}
