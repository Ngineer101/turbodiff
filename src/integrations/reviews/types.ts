import type { ReviewerInput } from '../../agents/reviewer.ts';
import type { ReviewArtifact, ReviewFinding } from '../../artifacts/review.ts';
import type { ReviewConclusion, ReviewPublicationEvent } from '../../domain/review-context.ts';

export type ReviewSource = {
  input: ReviewerInput;
  patch: string;
};

export type ReviewReadiness = {
  conclusion: ReviewConclusion;
  coverageStatus: 'complete' | 'incomplete' | 'stale';
  reviewableFileCount: number;
  coveredFileCount: number;
  missingPaths: string[];
  coverageHeadSha: string;
  publishedHeadSha: string | null;
};

export type ReviewPublicationPlan = {
  artifact: ReviewArtifact;
  findings: ReviewFinding[];
  event: ReviewPublicationEvent;
  verdict: 'approve' | 'comment' | 'request_changes';
  readiness: ReviewReadiness;
};

export type ReviewPublication =
  | {
      kind: 'published';
      url: string | null;
      fallback: string | null;
      inlineFindings: number;
    }
  | {
      kind: 'stale';
      currentRevision: string | null;
    };
