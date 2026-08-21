// The auto-merge decision, extracted so the GitHub path
// (services/auto-merge.ts) and the native change-request path
// (services/change-requests.ts) can never drift apart on policy — they
// already did once (the blocking_reviews pairing). Pure: callers gather the
// facts from their provider's sources; this answers with a decline reason or
// null for "merge".

export interface AutoMergeFacts {
  // repo.auto_merge === 1
  optedIn: boolean;
  // repo.blocking_reviews === 1 — auto-merge is only meaningful when the
  // review gate exists at all.
  blockingReviews: boolean;
  // The change belongs to a factory feature with acceptance criteria; trust
  // is earned empirically, so auto-merge never applies without them.
  hasAcceptanceCriteria: boolean;
  // The latest verification run passed every criterion.
  verificationPassed: boolean;
  // At least one turbodiff review exists (another bot's approval never
  // stands in for ours having run).
  reviewed: boolean;
  // ANY blocking-intent review — even one superseded by a clean re-review —
  // declines in favor of a human look.
  anyBlockingReview: boolean;
  // Native CI (change-request checks); GitHub callers pass true.
  checksGreen: boolean;
  hasConflict: boolean;
}

export function autoMergeDecline(facts: AutoMergeFacts): string | null {
  if (!facts.optedIn) return 'auto-merge disabled';
  if (!facts.blockingReviews) return 'blocking reviews disabled';
  if (!facts.hasAcceptanceCriteria) return 'no acceptance criteria to verify';
  if (!facts.verificationPassed) return 'verification not passed';
  if (!facts.reviewed) return 'no turbodiff review yet';
  if (facts.anyBlockingReview) return 'a review requested changes';
  if (!facts.checksGreen) return 'checks not green';
  if (facts.hasConflict) return 'merge conflict';
  return null;
}
