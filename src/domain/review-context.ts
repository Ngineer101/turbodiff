import { REVIEW_NOISE_PATTERNS, splitDiffSegments } from './review-diff.ts';

export interface ReviewDiffFile {
  path: string;
  chars: number;
  reviewable: boolean;
  omittedReason: string | null;
  included: boolean;
}

export interface ReviewDiffSnapshot {
  diff: string;
  files: ReviewDiffFile[];
  includedFiles: string[];
  remainingFiles: string[];
  complete: boolean;
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

// Builds an initial, whole-file review packet. It never slices through a file:
// every reviewable path that did not fit remains visible in the manifest and
// can be requested with fetch_diff. This avoids the old alphabetical-prefix
// blind spot where later files disappeared inside one truncated string.
export function buildReviewDiffSnapshot(diff: string, maxChars: number): ReviewDiffSnapshot {
  const output: string[] = [];
  const files: ReviewDiffFile[] = [];
  const includedFiles: string[] = [];
  const remainingFiles: string[] = [];
  let used = 0;

  for (const entry of splitDiffSegments(diff)) {
    const omittedReason = reviewDiffOmissionReason(entry.path, entry.segment);
    if (omittedReason) {
      const marker = `[turbodiff: diff for ${entry.path} omitted — ${omittedReason}]\n`;
      output.push(marker);
      used += marker.length;
      files.push({
        path: entry.path,
        chars: entry.segment.length,
        reviewable: false,
        omittedReason,
        included: false,
      });
      continue;
    }

    const included = used + entry.segment.length <= maxChars;
    files.push({
      path: entry.path,
      chars: entry.segment.length,
      reviewable: true,
      omittedReason: null,
      included,
    });
    if (included) {
      output.push(entry.segment);
      includedFiles.push(entry.path);
      used += entry.segment.length;
    } else {
      remainingFiles.push(entry.path);
    }
  }

  return {
    diff: output.join(''),
    files,
    includedFiles,
    remainingFiles,
    complete: remainingFiles.length === 0,
  };
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

export function reviewPublicationEvent(
  blockingReviews: boolean,
  hasP1: boolean,
  coverageComplete: boolean,
): ReviewPublicationEvent {
  if (!blockingReviews) return 'COMMENT';
  if (hasP1) return 'REQUEST_CHANGES';
  return coverageComplete ? 'APPROVE' : 'COMMENT';
}
