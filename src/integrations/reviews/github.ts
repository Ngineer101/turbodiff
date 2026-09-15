import type { ReviewFinding } from '../../artifacts/review.ts';
import type { RepositoryRow } from '../../data/db.ts';
import { installationToken } from '../github/app.ts';
import { githubJson, githubRequest } from '../github/client.ts';
import type { ReviewPublication, ReviewPublicationPlan } from './types.ts';

interface GithubReviewComment {
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  body: string;
  start_line?: number;
  start_side?: 'LEFT' | 'RIGHT';
}

function comments(findings: ReviewFinding[]) {
  return findings.map((finding) => {
    const comment: GithubReviewComment = {
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

function findingsMarkdown(findings: ReviewFinding[]): string {
  return findings
    .map((finding) => `**\`${finding.path}:${finding.line}\`**\n${finding.body}`)
    .join('\n\n');
}

function reviewBody(reviewerName: string, plan: ReviewPublicationPlan): string {
  let body = `**Turbodiff · ${reviewerName}**\n\n${plan.artifact.summary}`;
  if (plan.readiness.coverageStatus !== 'complete') {
    const paths = plan.readiness.missingPaths.slice(0, 20).map((path) => `\`${path}\``);
    body +=
      `\n\n_Coverage incomplete: ${plan.readiness.coveredFileCount}/` +
      `${plan.readiness.reviewableFileCount} reviewable files assessed.` +
      (paths.length > 0 ? ` Missing: ${paths.join(', ')}.` : '') +
      '_';
  }
  return `${body}\n\n— Turbodiff`;
}

export async function publishGithubReview(
  repository: RepositoryRow,
  number: number,
  expectedHeadSha: string,
  reviewerName: string,
  plan: ReviewPublicationPlan,
): Promise<ReviewPublication> {
  const installationId = Number(repository.source_external_account_id);
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    throw new Error('GitHub repository has no installation');
  }
  const token = await installationToken(installationId);
  const pullPath = `/repos/${repository.owner}/${repository.name}/pulls/${number}`;
  const current = await githubJson<{ head: { sha: string } }>(token, pullPath);
  if (current.head.sha !== expectedHeadSha) {
    return { kind: 'stale', currentRevision: current.head.sha };
  }

  let body = reviewBody(reviewerName, plan);
  let event = plan.event;
  let inline = comments(plan.findings);
  let fallback: string | null = null;
  let response: Response;
  try {
    response = await githubRequest(token, `${pullPath}/reviews`, {
      method: 'POST',
      body: JSON.stringify({ body, event, commit_id: expectedHeadSha, comments: inline }),
    });
  } catch (failure) {
    if (!String(failure).includes('422')) throw failure;
    if (inline.length > 0) {
      body += `\n\n### Findings\n\n${findingsMarkdown(plan.findings)}`;
      inline = [];
      fallback = 'inline anchors rejected; findings were published in the review body';
    }
    event = 'COMMENT';
    response = await githubRequest(token, `${pullPath}/reviews`, {
      method: 'POST',
      body: JSON.stringify({ body, event, commit_id: expectedHeadSha, comments: inline }),
    });
  }
  const published = await response.json<{ html_url?: string }>();
  return {
    kind: 'published',
    url: published.html_url ?? null,
    fallback,
    inlineFindings: inline.length,
  };
}
