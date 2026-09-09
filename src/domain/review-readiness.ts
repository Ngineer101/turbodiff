import type { ReviewConclusion } from './review-context.ts';

export interface ReviewReadinessEvidence {
  agentSlug: string | null;
  status: string;
  conclusion: ReviewConclusion | null;
  coveredFileCount: number | null;
  reviewableFileCount: number | null;
  missingPaths: string[] | null;
  findingsCount: number | null;
  error: string | null;
}

export interface ReviewReadinessReport {
  conclusion: ReviewConclusion;
  checkConclusion: 'success' | 'failure';
  title: string;
  summary: string;
  text: string;
}

export function reviewReadinessReport(evidence: ReviewReadinessEvidence[]): ReviewReadinessReport {
  const failed = evidence.filter((item) => item.status === 'failed');
  const inconclusive = evidence.filter(
    (item) => item.status !== 'completed' || item.conclusion === 'inconclusive' || !item.conclusion,
  );
  const notReady = evidence.filter((item) => item.conclusion === 'not_ready');
  const warning = evidence.some((item) => item.conclusion === 'ready_with_warnings');
  const conclusion: ReviewConclusion =
    evidence.length === 0 || failed.length > 0 || inconclusive.length > 0
      ? 'inconclusive'
      : notReady.length > 0
        ? 'not_ready'
        : warning
          ? 'ready_with_warnings'
          : 'ready';
  const covered = evidence.reduce((sum, item) => sum + (item.coveredFileCount ?? 0), 0);
  const reviewable = evidence.reduce((sum, item) => sum + (item.reviewableFileCount ?? 0), 0);
  const findings = evidence.reduce((sum, item) => sum + (item.findingsCount ?? 0), 0);
  const title =
    conclusion === 'ready'
      ? 'Review gate passed'
      : conclusion === 'ready_with_warnings'
        ? 'Review gate passed with warnings'
        : conclusion === 'not_ready'
          ? 'Review gate failed'
          : 'Review evidence is inconclusive';
  const summary =
    `Conclusion: ${conclusion.replaceAll('_', ' ')}. ` +
    `${evidence.length} required reviewer(s); ${covered}/${reviewable} file assessment(s) covered; ` +
    `${findings} verified finding(s).`;
  const rows = evidence.map((item) => {
    const missing = item.missingPaths?.length
      ? `; missing ${item.missingPaths.slice(0, 10).join(', ')}${item.missingPaths.length > 10 ? ', …' : ''}`
      : '';
    const reason = item.error ? `; ${item.error}` : '';
    return (
      `- ${item.agentSlug ?? 'review'}: ${item.status}/${item.conclusion ?? 'no conclusion'}; ` +
      `${item.coveredFileCount ?? 0}/${item.reviewableFileCount ?? 0} covered${missing}${reason}`
    );
  });
  return {
    conclusion,
    checkConclusion:
      conclusion === 'ready' || conclusion === 'ready_with_warnings' ? 'success' : 'failure',
    title,
    summary,
    text: rows.join('\n').slice(0, 60_000),
  };
}
