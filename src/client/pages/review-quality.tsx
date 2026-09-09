import { useMutation, useSuspenseQuery } from '@tanstack/react-query';
import { Check, CircleX, Clock3, GitPullRequest, Wrench } from 'lucide-react';
import type { ApiReviewFindingFeedback, ApiReviewQuality } from '../../shared/api-types.ts';
import { Markdown } from '../components/markdown.tsx';
import { EmptyState, Muted, PageTitle, SectionHeading } from '../components/section.tsx';
import { StatTile } from '../components/stat-tile.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card } from '../components/ui/card.tsx';
import { Pill } from '../components/ui/pill.tsx';
import { api } from '../lib/api.ts';
import { ago, fmtDuration, fmtUsd } from '../lib/format.ts';
import { queryClient, reviewQualityQuery } from '../lib/queries.ts';

const feedbackOptions = [
  { value: 'useful', label: 'Useful', icon: Check },
  { value: 'false_positive', label: 'False positive', icon: CircleX },
  { value: 'fixed', label: 'Fixed', icon: Wrench },
  { value: 'dismissed', label: 'Dismiss', icon: Clock3 },
] as const;

function percentage(numerator: number, denominator: number): string {
  return denominator > 0 ? `${Math.round((numerator / denominator) * 100)}%` : '—';
}

export function ReviewQualityPage() {
  const { data } = useSuspenseQuery(reviewQualityQuery);
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
        Track verified findings and label their usefulness to improve future reviews.
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
          label="Verifier retention"
          value={percentage(data.stats.published, data.stats.candidates)}
          sub={`${data.stats.published} of ${data.stats.candidates} candidates`}
        />
        <StatTile
          index={2}
          label="Verifier latency"
          value={
            data.stats.avg_verification_latency_ms === null
              ? '—'
              : fmtDuration(data.stats.avg_verification_latency_ms / 1000)
          }
          sub="Average verification time"
        />
        <StatTile
          index={3}
          label="Verifier cost"
          value={fmtUsd(data.stats.verification_cost_usd)}
          sub="Verification only"
        />
      </div>

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
        <EmptyState>Verified findings will appear here after the next review.</EmptyState>
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
                  {finding.verification_reason ? (
                    <p className="mt-3 border-l-2 border-line-2 pl-3 text-xs leading-relaxed wrap-anywhere text-mute">
                      <span className="font-medium text-ink-dim">Verifier: </span>
                      {finding.verification_reason}
                    </p>
                  ) : null}
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
