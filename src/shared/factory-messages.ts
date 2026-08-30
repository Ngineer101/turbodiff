// Queue contracts cross the HTTP, service, Worker-entrypoint, workflow, and
// runner boundaries. Keeping them in shared prevents those layers from
// importing one another just to agree on transport shapes.
import type { RunStageCommand } from '../domain/lifecycle-contract.ts';

export const FIX_MAX_ATTEMPTS = 3;

// Chat turns blocked by another in-flight sandbox run on the same PR
// re-enqueue themselves with a delay rather than failing outright.
export const CHAT_BUSY_RETRIES = 10;
export const CHAT_BUSY_DELAY_SECONDS = 30;

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
  // Present when the lifecycle coordinator owns this repair attempt.
  factoryRunId?: number;
  stageRunId?: number;
  changeId?: number;
}

export interface ChatQueueMessage {
  kind: 'chat';
  featureId: number;
  chatMessageId: number;
  // Busy-retry counter: bumped each time the turn found another sandbox run
  // in flight and re-enqueued itself with a delay.
  attempt?: number;
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
  | RunStageCommand
  | GenerateQueueMessage
  | PlanQueueMessage
  | VerifyQueueMessage
  | AutomationQueueMessage
  | FixQueueMessage
  | ChatQueueMessage
  | ConflictResolveQueueMessage
  | CrReviewQueueMessage
  | CrMergeQueueMessage;
