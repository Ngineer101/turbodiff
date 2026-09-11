import { env } from 'cloudflare:workers';
import type { ReviewerInput } from '../../agents/reviewer.ts';
import type { RepositoryRow } from '../../data/db.ts';
import {
  getChangeRequest,
  listCrComments,
  publishNativeReview,
  type ChangeRequestRow,
} from '../../data/db.ts';
import { buildReviewDiffSnapshot } from '../../domain/review-context.ts';
import { cockpitFeatureUrl } from '../../application/urls.ts';
import type { ReviewPublication, ReviewPublicationPlan, ReviewSource } from './types.ts';

export async function loadArtifactsReviewSource(
  repo: RepositoryRow,
  changeRequestId: number,
  expectedRevision: string,
  focus: ReviewerInput['focus'],
  changedSincePreviousReview: ReviewerInput['changedSincePreviousReview'],
): Promise<{ source: ReviewSource; changeRequest: ChangeRequestRow } | null> {
  const changeRequest = await getChangeRequest(changeRequestId);
  if (
    !changeRequest ||
    changeRequest.repository_id !== repo.id ||
    changeRequest.status !== 'open' ||
    changeRequest.source_head !== expectedRevision
  ) {
    return null;
  }
  const [storedPatch, comments] = await Promise.all([
    changeRequest.diff_key ? env.ARTIFACTS.get(changeRequest.diff_key) : null,
    listCrComments(changeRequest.id),
  ]);
  const rawPatch = storedPatch ? await storedPatch.text() : '';
  const snapshot = buildReviewDiffSnapshot(rawPatch);
  const description =
    comments.find((comment) => comment.kind === 'summary' && comment.author !== 'turbodiff[bot]')
      ?.body ?? '';
  return {
    changeRequest,
    source: {
      input: {
        repository: `${repo.owner}/${repo.name}`,
        change: {
          title: changeRequest.title,
          description,
          base: changeRequest.target_branch,
          head: changeRequest.source_branch,
          revision: expectedRevision,
          files: snapshot.files.map((file) => ({
            path: file.path,
            reviewable: file.reviewable,
            omittedReason: file.omittedReason,
          })),
        },
        focus,
        changedSincePreviousReview,
      },
      patch: snapshot.diff,
    },
  };
}

function summaryBody(reviewerName: string, plan: ReviewPublicationPlan): string {
  let body = `**Turbodiff · ${reviewerName}**\n\n${plan.artifact.summary}`;
  if (plan.readiness.coverageStatus !== 'complete') {
    body +=
      `\n\n_Coverage incomplete: ${plan.readiness.coveredFileCount}/${plan.readiness.reviewableFileCount} ` +
      `reviewable files assessed. Missing: ${plan.readiness.missingPaths
        .slice(0, 20)
        .map((path) => `\`${path}\``)
        .join(', ')}._`;
  }
  return `${body}\n\n— Turbodiff 🤖`;
}

export async function publishArtifactsReview(
  changeRequestId: number,
  expectedRevision: string,
  reviewerName: string,
  plan: ReviewPublicationPlan,
): Promise<ReviewPublication> {
  const current = await getChangeRequest(changeRequestId);
  if (!current || current.source_head !== expectedRevision) {
    return { kind: 'stale', currentRevision: current?.source_head ?? null };
  }
  const blocks = plan.verdict === 'request_changes';
  const published = await publishNativeReview(changeRequestId, {
    expectedHead: expectedRevision,
    findings: plan.findings.map((finding) => ({
      path: finding.path,
      line: finding.line,
      severity: finding.severity,
      body: finding.body,
    })),
    summary: summaryBody(reviewerName, plan),
    reviewStatus: blocks ? 'changes_requested' : 'approved',
    checkStatus: blocks || plan.readiness.conclusion === 'inconclusive' ? 'failed' : 'passed',
    checkSummary:
      plan.readiness.conclusion === 'inconclusive'
        ? `inconclusive — ${plan.readiness.missingPaths.length} reviewable file(s) missing`
        : `${plan.findings.length} finding(s)` + (blocks ? ' — P1 blocks merge' : ''),
  });
  if (!published) {
    const latest = await getChangeRequest(changeRequestId);
    return { kind: 'stale', currentRevision: latest?.source_head ?? null };
  }
  return {
    kind: 'published',
    url: current.feature_id ? cockpitFeatureUrl(current.feature_id) : null,
    fallback: null,
    inlineFindings: plan.findings.length,
  };
}
