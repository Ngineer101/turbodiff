import { REVIEW_NOISE_PATTERNS, splitDiffSegments } from './review-diff.ts';

export interface ReviewDiffFile {
  path: string;
  reviewable: boolean;
  omittedReason: string | null;
}

export interface ReviewDiffSnapshot {
  diff: string;
  files: ReviewDiffFile[];
}

function generatedReason(path: string, segment: string): string | null {
  if (/migration/i.test(path)) return null;
  const hunk = segment.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@.*$/m);
  if (!hunk || Number(hunk[1]) > 3) return null;
  const start = segment.indexOf(hunk[0]) + hunk[0].length;
  return segment
    .slice(start)
    .split('\n', 10)
    .some((line) => line.includes('@generated'))
    ? 'generated file'
    : null;
}

export function reviewDiffOmissionReason(path: string, segment: string): string | null {
  return (
    REVIEW_NOISE_PATTERNS.find((noise) => noise.pattern.test(path))?.reason ??
    generatedReason(path, segment)
  );
}

// Produces the complete review patch and manifest. Machine-generated noise is
// replaced by an explicit marker; reviewable files are never paged or hidden.
export function buildReviewDiffSnapshot(diff: string): ReviewDiffSnapshot {
  const output: string[] = [];
  const files: ReviewDiffFile[] = [];

  for (const entry of splitDiffSegments(diff)) {
    const omittedReason = reviewDiffOmissionReason(entry.path, entry.segment);
    if (omittedReason) {
      output.push(`[turbodiff: diff for ${entry.path} omitted — ${omittedReason}]\n`);
      files.push({ path: entry.path, reviewable: false, omittedReason });
      continue;
    }

    output.push(entry.segment);
    files.push({ path: entry.path, reviewable: true, omittedReason: null });
  }

  return { diff: output.join(''), files };
}

export function missingReviewFiles(
  manifest: Pick<ReviewDiffFile, 'path' | 'reviewable'>[],
  reviewedFiles: string[],
): string[] {
  const reviewed = new Set(reviewedFiles);
  return manifest
    .filter((file) => file.reviewable && !reviewed.has(file.path))
    .map((file) => file.path);
}

export type ReviewPublicationEvent = 'COMMENT' | 'REQUEST_CHANGES' | 'APPROVE';

export const REVIEW_CONCLUSIONS = [
  'ready',
  'ready_with_warnings',
  'not_ready',
  'inconclusive',
] as const;
export type ReviewConclusion = (typeof REVIEW_CONCLUSIONS)[number];

// A GitHub review event is only presentation. This is the durable trust
// conclusion consumed by lifecycle and merge policy: uncertainty never
// becomes a clean result merely because no blocking finding was published.
export function reviewConclusion(
  hasP1: boolean,
  hasP2: boolean,
  coverageComplete: boolean,
): ReviewConclusion {
  if (!coverageComplete) return 'inconclusive';
  if (hasP1) return 'not_ready';
  return hasP2 ? 'ready_with_warnings' : 'ready';
}

export function reviewPublicationEvent(
  blockingReviews: boolean,
  hasP1: boolean,
  coverageComplete: boolean,
): ReviewPublicationEvent {
  if (!blockingReviews) return 'COMMENT';
  if (hasP1) return 'REQUEST_CHANGES';
  return coverageComplete ? 'APPROVE' : 'COMMENT';
}
