import { useMutation, useSuspenseQuery } from '@tanstack/react-query';
import { Check, CircleX, Clock3, ExternalLink, GitPullRequest, Wrench } from 'lucide-react';
import type {
  ApiReview,
  ApiReviewFindingFeedback,
  ApiReviewQuality,
} from '../../shared/api-types.ts';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '../components/ui/accordion.tsx';
import { Markdown } from '../components/markdown.tsx';
import { EmptyState, Muted, PageTitle, SectionHeading } from '../components/section.tsx';
import { StatTile } from '../components/stat-tile.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card } from '../components/ui/card.tsx';
import { Pill } from '../components/ui/pill.tsx';
import { api } from '../lib/api.ts';
import { ago } from '../lib/format.ts';
import { queryClient, reviewQualityQuery, reviewsQuery } from '../lib/queries.ts';

const feedbackOptions = [
  { value: 'useful', label: 'Useful', icon: Check },
  { value: 'false_positive', label: 'False positive', icon: CircleX },
  { value: 'fixed', label: 'Fixed', icon: Wrench },
  { value: 'dismissed', label: 'Dismiss', icon: Clock3 },
] as const;

function percentage(numerator: number, denominator: number): string {
  return denominator > 0 ? `${Math.round((numerator / denominator) * 100)}%` : '—';
}

interface ReviewSignal {
  label: string;
  tone: 'neutral' | 'on' | 'running' | 'red' | 'warn';
}

function reviewSignal(review: ApiReview): ReviewSignal {
  if (review.state === 'running') return { label: 'Reviewing', tone: 'running' };
  if (review.state === 'stalled') return { label: 'Inconclusive · stalled', tone: 'red' };
  if (review.state === 'failed') return { label: 'Inconclusive · failed', tone: 'red' };
  switch (review.conclusion) {
    case 'ready':
      return { label: 'Ready', tone: 'on' };
    case 'ready_with_warnings':
      return { label: 'Ready · warnings', tone: 'warn' };
    case 'not_ready':
      return { label: 'Not ready', tone: 'red' };
    case 'inconclusive':
      return { label: 'Inconclusive', tone: 'red' };
    default:
      return { label: 'Legacy · no evidence', tone: 'neutral' };
  }
}

function ReviewReadinessCard({ review }: { review: ApiReview }) {
  const signal = reviewSignal(review);
  const covered = review.covered_file_count ?? 0;
  const total = review.reviewable_file_count ?? 0;
  const coverage = total > 0 ? Math.round((covered / total) * 100) : null;
  const coverageComplete = review.coverage_status === 'complete' && coverage === 100;
  const blocked = review.file_evidence.filter((item) => item.disposition === 'blocked');
  return (
    <AccordionItem value={String(review.id)}>
      <AccordionTrigger aside={<Pill tone={signal.tone}>{signal.label}</Pill>} className="gap-3">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-left">
          <span className="font-mono text-xs text-ink">
            {review.repo ? `${review.repo}#${review.pr_number}` : `PR #${review.pr_number}`}
          </span>
          <span className="text-xs text-mute">{review.agent_slug ?? 'review'}</span>
          <span className="text-xs text-mute">{ago(review.created_at)}</span>
        </span>
      </AccordionTrigger>
      <AccordionContent>
        <div className="space-y-4 pt-1 text-[0.82rem] text-ink-dim">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <div className="font-mono text-[10px] tracking-[0.12em] text-mute uppercase">
                Coverage
              </div>
              <div className="mt-1 font-mono text-sm text-ink">
                {review.reviewable_file_count === null
                  ? 'Not recorded'
                  : `${covered}/${total} files · ${review.coverage_status ?? 'unknown'}`}
              </div>
              {coverage !== null ? (
                <div
                  className="mt-2 h-1.5 overflow-hidden rounded-full bg-raised"
                  role="progressbar"
                  aria-label="Review coverage"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={coverage}
                >
                  <div
                    className={coverageComplete ? 'h-full bg-go' : 'h-full bg-danger'}
                    style={{ width: `${coverage}%` }}
                  />
                </div>
              ) : null}
            </div>

            <div>
              <div className="font-mono text-[10px] tracking-[0.12em] text-mute uppercase">
                Evidence head
              </div>
              <div className="mt-1 font-mono text-sm text-ink">
                {review.coverage_head_sha?.slice(0, 12) ?? 'Not recorded'}
              </div>
            </div>
          </div>

          {review.error ? (
            <p className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-danger">
              {review.error}
            </p>
          ) : null}
          {review.missing_paths.length > 0 ? (
            <div>
              <div className="font-mono text-[10px] tracking-[0.12em] text-danger uppercase">
                Missing review evidence
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {review.missing_paths.map((path) => (
                  <code
                    key={path}
                    className="rounded bg-danger/8 px-2 py-1 text-[11px] text-danger"
                  >
                    {path}
                  </code>
                ))}
              </div>
            </div>
          ) : null}
          {review.file_evidence.length > 0 ? (
            <div>
              <div className="font-mono text-[10px] tracking-[0.12em] text-mute uppercase">
                Per-file audit trail
              </div>
              <ul className="mt-2 space-y-1.5">
                {review.file_evidence.map((item) => (
                  <li key={item.path} className="rounded-lg border border-line/70 px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="text-[11px] text-ink">{item.path}</code>
                      <Pill tone={item.disposition === 'reviewed' ? 'on' : 'red'}>
                        {item.disposition ?? 'unacknowledged'}
                      </Pill>
                    </div>
                    {item.evidence ? (
                      <p className="mt-1 text-xs text-mute">{item.evidence}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {blocked.length > 0 ? (
            <p className="text-xs text-danger">
              {blocked.length} file{blocked.length === 1 ? '' : 's'} explicitly blocked review.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-3 text-xs">
            {review.pr_url ? (
              <a
                href={review.pr_url}
                target="_blank"
                rel="noreferrer"
                className="text-accent-bright hover:underline"
              >
                Open pull request <ExternalLink className="ml-1 inline size-3" aria-hidden />
              </a>
            ) : null}
            {review.review_url ? (
              <a
                href={review.review_url}
                target="_blank"
                rel="noreferrer"
                className="text-accent-bright hover:underline"
              >
                Open published review <ExternalLink className="ml-1 inline size-3" aria-hidden />
              </a>
            ) : null}
          </div>
        </div>
      </AccordionContent>
    </AccordionItem>
  );
}

export function ReviewQualityPage() {
  const { data } = useSuspenseQuery(reviewQualityQuery);
  const { data: activity } = useSuspenseQuery(reviewsQuery);
  const precisionLabels = data.stats.true_positives + data.stats.false_positives;
  const feedback = useMutation({
    mutationFn: ({ id, value }: { id: number; value: ApiReviewFindingFeedback }) =>
      api.patch(`/api/review-findings/${id}`, { feedback: value }),
    onMutate: async ({ id, value }) => {
      await queryClient.cancelQueries({ queryKey: ['review-quality'] });
      const previous = queryClient.getQueryData<ApiReviewQuality>(['review-quality']);
      queryClient.setQueryData<ApiReviewQuality>(['review-quality'], (current) =>
        current
          ? {
              ...current,
              findings: current.findings.map((finding) =>
                finding.id === id ? { ...finding, feedback: value } : finding,
              ),
            }
          : current,
      );
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(['review-quality'], context.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['review-quality'] }),
  });

  return (
    <>
      <PageTitle aside={<Muted>Last 30 days</Muted>}>Review quality</PageTitle>
      <p className="mt-1 text-[0.85rem] leading-relaxed text-mute">
        Track published findings and label their usefulness to improve future reviews.
      </p>

      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          index={0}
          label="Labeled precision"
          value={percentage(data.stats.true_positives, precisionLabels)}
          sub={`${precisionLabels} confirmed labels`}
        />
        <StatTile
          index={1}
          label="Published findings"
          value={String(data.stats.published)}
          sub="Across completed reviews"
        />
        <StatTile
          index={2}
          label="Feedback coverage"
          value={percentage(data.stats.labeled, data.stats.published)}
          sub={`${data.stats.labeled} findings labeled`}
        />
        <StatTile
          index={3}
          label="False positives"
          value={String(data.stats.false_positives)}
          sub="Marked by reviewers"
        />
      </div>

      <SectionHeading aside={<Muted>Latest {activity.reviews.length} review runs</Muted>}>
        Readiness history
      </SectionHeading>
      {activity.reviews.length === 0 ? (
        <EmptyState>Review readiness evidence will appear after the next review.</EmptyState>
      ) : (
        <Accordion
          type="multiple"
          className="rounded-xl border border-line bg-surface px-4 shadow-edge"
        >
          {activity.reviews.map((review) => (
            <ReviewReadinessCard key={review.id} review={review} />
          ))}
        </Accordion>
      )}

      <SectionHeading
        aside={
          <Muted>
            {data.stats.labeled} of {data.stats.published} published findings labeled
          </Muted>
        }
      >
        Finding inbox
      </SectionHeading>

      {data.findings.length === 0 ? (
        <EmptyState>Published findings will appear here after the next review.</EmptyState>
      ) : (
        <div className="space-y-3">
          {data.findings.map((finding) => (
            <article key={finding.id}>
              <Card className="min-w-0 p-0">
                <div className="space-y-2 border-b border-line px-4 py-3">
                  <div className="flex items-start justify-between gap-3 text-xs">
                    <div className="flex min-w-0 items-start gap-2">
                      <Pill tone={finding.severity === 'P1' ? 'red' : 'warn'}>
                        {finding.severity}
                      </Pill>
                      {finding.repo ? (
                        <a
                          href={`https://github.com/${finding.repo}/pull/${finding.pr_number}`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex min-w-0 items-start gap-1.5 font-mono leading-5 text-accent-bright hover:underline"
                        >
                          <GitPullRequest className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                          <span className="min-w-0 wrap-anywhere">
                            {finding.repo}#{finding.pr_number}
                          </span>
                        </a>
                      ) : (
                        <Muted>Repository removed</Muted>
                      )}
                    </div>
                    <span className="shrink-0 leading-5 text-mute">{ago(finding.created_at)}</span>
                  </div>
                  <div className="font-mono text-xs leading-relaxed wrap-anywhere text-mute">
                    {finding.path}:{finding.line}
                  </div>
                </div>
                <div className="px-4 py-3">
                  <Markdown className="markdown-body--compact min-w-0 wrap-anywhere [&>:first-child]:mt-0! [&>:last-child]:mb-0!">
                    {finding.body}
                  </Markdown>

                </div>
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-b-lg border-t border-line bg-surface-2 px-4 py-3">
                  <span className="font-mono text-[10px] tracking-[0.14em] text-mute uppercase">
                    Finding feedback
                  </span>
                  <div
                    className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap"
                    role="group"
                    aria-label="Finding feedback"
                  >
                    {feedbackOptions.map((option) => {
                      const Icon = option.icon;
                      return (
                        <Button
                          key={option.value}
                          size="sm"
                          variant={finding.feedback === option.value ? 'default' : 'secondary'}
                          aria-pressed={finding.feedback === option.value}
                          loading={feedback.isPending && feedback.variables?.id === finding.id}
                          onClick={() => feedback.mutate({ id: finding.id, value: option.value })}
                        >
                          <Icon className="size-3.5" aria-hidden />
                          {option.label}
                        </Button>
                      );
                    })}
                  </div>
                </div>
              </Card>
            </article>
          ))}
        </div>
      )}
    </>
  );
}
