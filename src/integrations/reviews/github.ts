import type { ReviewerInput } from '../../agents/reviewer.ts';
import type { ReviewFinding } from '../../artifacts/review.ts';
import type { RepositoryRow } from '../../data/db.ts';
import { buildReviewDiffSnapshot } from '../../domain/review-context.ts';
import { installationToken } from '../github/app.ts';
import { githubRequest as gh } from '../github/client.ts';
import type { ReviewPublication, ReviewPublicationPlan, ReviewSource } from './types.ts';

interface PullRequestMetadata {
  title: string;
  body: string | null;
  base: { ref: string };
  head: { ref: string; sha: string };
}

async function pullRequestDiff(
  token: string,
  owner: string,
  repo: string,
  number: number,
): Promise<string> {
  return gh(token, `/repos/${owner}/${repo}/pulls/${number}`, {
    accept: 'application/vnd.github.v3.diff',
  }).then((response) => response.text());
}

export async function loadGithubReviewSource(
  repo: RepositoryRow,
  number: number,
  expectedRevision: string,
  focus: ReviewerInput['focus'],
  changedSincePreviousReview: ReviewerInput['changedSincePreviousReview'],
): Promise<ReviewSource | null> {
  const token = await installationToken(repo.installation_id);
  const path = `/repos/${repo.owner}/${repo.name}/pulls/${number}`;
  const [metadata, rawPatch] = await Promise.all([
    gh(token, path).then((response) => response.json<PullRequestMetadata>()),
    pullRequestDiff(token, repo.owner, repo.name, number),
  ]);
  if (metadata.head.sha !== expectedRevision) return null;
  const snapshot = buildReviewDiffSnapshot(rawPatch);
  return {
    input: {
      repository: `${repo.owner}/${repo.name}`,
      change: {
        title: metadata.title,
        description: metadata.body ?? '',
        base: metadata.base.ref,
        head: metadata.head.ref,
        revision: metadata.head.sha,
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
  };
}

interface ReviewComment {
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  body: string;
  start_line?: number;
  start_side?: 'LEFT' | 'RIGHT';
}

function comments(findings: ReviewFinding[]): ReviewComment[] {
  return findings.map((finding) => {
    const comment: ReviewComment = {
      path: finding.path,
      line: finding.line,
      side: finding.side,
      body: finding.body,
    };
    if (finding.startLine !== undefined) {
      comment.start_line = finding.startLine;
      comment.start_side = finding.side;
    }
    return comment;
  });
}

function findingsAsMarkdown(findings: ReviewFinding[]): string {
  return findings
    .map((finding) => `**\`${finding.path}:${finding.line}\`**\n${finding.body}`)
    .join('\n\n');
}

function reviewBody(reviewerName: string, plan: ReviewPublicationPlan): string {
  let body = `**Turbodiff · ${reviewerName}**\n\n${plan.artifact.summary}`;
  if (plan.readiness.coverageStatus !== 'complete') {
    const shown = plan.readiness.missingPaths.slice(0, 20).map((path) => `\`${path}\``);
    const remaining = plan.readiness.missingPaths.length - shown.length;
    body +=
      `\n\n_Coverage incomplete: ${plan.readiness.coveredFileCount}/${plan.readiness.reviewableFileCount} ` +
      `reviewable files assessed. Missing: ${shown.join(', ')}` +
      (remaining > 0 ? `, and ${remaining} more` : '') +
      '._';
  }
  const blocked = plan.artifact.fileEvidence.filter((item) => item.disposition === 'blocked');
  if (blocked.length > 0) {
    body +=
      '\n\nBlocked-file evidence:\n' +
      blocked
        .slice(0, 20)
        .map((item) => `- \`${item.path}\`: ${item.evidence}`)
        .join('\n');
  }
  return `${body}\n\n— Turbodiff 🤖`;
}

export async function publishGithubReview(
  repo: RepositoryRow,
  number: number,
  expectedRevision: string,
  reviewerName: string,
  plan: ReviewPublicationPlan,
): Promise<ReviewPublication> {
  const token = await installationToken(repo.installation_id);
  const pullPath = `/repos/${repo.owner}/${repo.name}/pulls/${number}`;
  const current = await gh(token, pullPath).then((response) =>
    response.json<{ head: { sha: string } }>(),
  );
  if (current.head.sha !== expectedRevision) {
    return { kind: 'stale', currentRevision: current.head.sha };
  }

  const reviewPath = `${pullPath}/reviews`;
  const intendedEvent = plan.event;
  let event = intendedEvent;
  let body = reviewBody(reviewerName, plan);
  let reviewComments = comments(plan.findings);
  let fallback: string | null = null;
  let review: { html_url?: string };

  for (let attempt = 0; ; attempt++) {
    try {
      const response = await gh(token, reviewPath, {
        method: 'POST',
        body: JSON.stringify({
          body,
          event,
          commit_id: expectedRevision,
          comments: reviewComments,
        }),
      });
      review = await response.json<{ html_url?: string }>();
      break;
    } catch (error) {
      const message = String(error);
      if (!message.includes('422') || attempt >= 2) throw error;
      if (/own pull request/i.test(message) && event !== 'COMMENT') {
        event = 'COMMENT';
        body =
          `**Verdict: ${intendedEvent}** _(GitHub does not let the pull-request author submit this verdict.)_\n\n` +
          body;
        fallback = 'self-authored pull request: verdict published as a comment';
      } else if (reviewComments.length > 0) {
        body = `${body}\n\n### Findings\n\n${findingsAsMarkdown(plan.findings)}`;
        reviewComments = [];
        fallback = 'inline anchors rejected: findings published in the review body';
      } else {
        throw error;
      }
    }
  }

  return {
    kind: 'published',
    url: review.html_url ?? null,
    fallback,
    inlineFindings: reviewComments.length,
  };
}
