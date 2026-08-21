// Queue contracts cross the HTTP, service, Worker-entrypoint, workflow, and
// runner boundaries. Keeping them in shared prevents those layers from
// importing one another just to agree on transport shapes.

export const FIX_MAX_ATTEMPTS = 3;

export interface GenerateQueueMessage {
  kind: 'generate';
  featureId: number;
  // Legacy field from the pre-workflow retry loop; ignored.
  attempt?: number;
}

export type PlanQueueMessage =
  | { kind: 'plan_analyze'; planId: number }
  | { kind: 'plan_refine'; planId: number };

export interface VerifyQueueMessage {
  kind: 'verify';
  featureId: number;
}

export interface AutomationQueueMessage {
  kind: 'automation';
  automationId: number;
}

export interface FixQueueMessage {
  kind: 'fix';
  repoId: number;
  prNumber: number;
  trigger: string;
  findings?: string;
  author?: { login: string; id: number };
  commentIds?: number[];
  workflowRunId?: number;
}

export interface ConflictResolveQueueMessage {
  kind: 'resolve_conflict';
  repoId: number;
  prNumber: number;
}

export interface CrReviewQueueMessage {
  kind: 'cr_review';
  changeRequestId: number;
}

export interface CrMergeQueueMessage {
  kind: 'cr_merge';
  changeRequestId: number;
  actor: string;
}

export type FactoryMessage =
  | GenerateQueueMessage
  | PlanQueueMessage
  | VerifyQueueMessage
  | AutomationQueueMessage
  | FixQueueMessage
  | ConflictResolveQueueMessage
  | CrReviewQueueMessage
  | CrMergeQueueMessage;
