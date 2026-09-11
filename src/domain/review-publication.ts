import type { ReviewerInput } from '../agents/reviewer.ts';
import type { ReviewArtifact, ReviewFinding } from '../artifacts/review.ts';
import type { ReviewPublicationPlan } from '../integrations/reviews/types.ts';
import { missingReviewFiles, reviewConclusion, reviewPublicationEvent } from './review-context.ts';

function findingFingerprint(finding: ReviewFinding): string {
  return [
    finding.path.toLowerCase(),
    finding.side,
    finding.line,
    finding.body.toLowerCase().replaceAll(/\s+/g, ' ').trim(),
  ].join(':');
}

function uniqueFindings(findings: ReviewFinding[]): ReviewFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const fingerprint = findingFingerprint(finding);
    if (seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    return true;
  });
}

function publicFinding(finding: ReviewFinding): ReviewFinding {
  const tag = finding.severity === 'P1' ? '🔴 **P1**' : '🟡 **P2**';
  const body = /^(?:🔴|🟡)?\s*\*\*P[12]\*\*/u.test(finding.body)
    ? finding.body.replace(/^(?:🔴|🟡)?\s*\*\*P[12]\*\*/u, tag)
    : `${tag} ${finding.body}`;
  return { ...finding, body };
}

export function planReviewPublication(
  input: ReviewerInput,
  artifact: ReviewArtifact,
  blockingReviews: boolean,
): ReviewPublicationPlan {
  const reviewable = new Set(
    input.change.files.filter((file) => file.reviewable).map((file) => file.path),
  );
  const findings = uniqueFindings(
    artifact.findings.filter((finding) => reviewable.has(finding.path)),
  ).map(publicFinding);
  const evidence = artifact.fileEvidence.filter((item) => reviewable.has(item.path));
  const reviewedPaths = evidence
    .filter((item) => item.disposition === 'reviewed')
    .map((item) => item.path);
  const missingPaths = missingReviewFiles(input.change.files, reviewedPaths);
  const reviewableFileCount = reviewable.size;
  const coveredFileCount = reviewableFileCount - missingPaths.length;
  const coverageComplete = missingPaths.length === 0;
  const hasP1 = findings.some((finding) => finding.severity === 'P1');
  const hasP2 = findings.some((finding) => finding.severity === 'P2');
  const event = reviewPublicationEvent(blockingReviews, hasP1, coverageComplete);

  return {
    artifact,
    findings,
    event,
    verdict: hasP1 ? 'request_changes' : coverageComplete ? 'approve' : 'comment',
    readiness: {
      conclusion: reviewConclusion(hasP1, hasP2, coverageComplete),
      coverageStatus: coverageComplete ? 'complete' : 'incomplete',
      reviewableFileCount,
      coveredFileCount,
      missingPaths,
      coverageHeadSha: input.change.revision,
      publishedHeadSha: input.change.revision,
    },
  };
}
