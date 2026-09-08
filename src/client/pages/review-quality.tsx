import { useMutation, useSuspenseQuery } from '@tanstack/react-query';
import { Check, CircleX, Clock3, GitPullRequest, Wrench } from 'lucide-react';
import type { ApiReviewFindingFeedback, ApiReviewQuality } from '../../shared/api-types.ts';
import { EmptyState, Muted, PageTitle, SectionHeading } from '../components/section.tsx';
import { StatTile } from '../components/stat-tile.tsx';
import { Button } from '../components/ui/button.tsx';
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
      <PageTitle
        aside={<Muted>Rolling 30 days · labels become the regression-eval truth set</Muted>}
      >
        Review quality
      </PageTitle>

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
          sub="Average independent pass"
        />
        <StatTile
          index={3}
          label="Verifier cost"
          value={fmtUsd(data.stats.verification_cost_usd)}
          sub="Separate from scout attribution"
        />
      </div>

      <SectionHeading
        aside={
          <Muted>
            {data.stats.labeled}/{data.stats.published} published findings labeled
          </Muted>
        }
      >
        Finding inbox
      </SectionHeading>

      {data.findings.length === 0 ? (
        <EmptyState>Verified findings will appear here after the next review.</EmptyState>
      ) : (
        <div className="space-y-2.5">
          {data.findings.map((finding) => (
            <article
              key={finding.id}
              className="animate-rise rounded-xl border border-line bg-surface px-4 py-3 shadow-edge"
            >
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Pill tone={finding.severity === 'P1' ? 'red' : 'warn'}>{finding.severity}</Pill>
                {finding.repo ? (
                  <a
                    href={`https://github.com/${finding.repo}/pull/${finding.pr_number}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-mono text-accent-bright hover:underline"
                  >
                    <GitPullRequest className="size-3.5" aria-hidden />
                    {finding.repo}#{finding.pr_number}
                  </a>
                ) : (
                  <Muted>Repository removed</Muted>
                )}
                <span className="font-mono text-mute">
                  {finding.path}:{finding.line}
                </span>
                <span className="ml-auto text-mute">{ago(finding.created_at)}</span>
              </div>
              <p className="mt-2 whitespace-pre-wrap text-[0.86rem] leading-relaxed text-ink-dim">
                {finding.body}
              </p>
              {finding.verification_reason ? (
                <p className="mt-2 border-l-2 border-accent/40 pl-2 text-xs text-mute">
                  Verifier: {finding.verification_reason}
                </p>
              ) : null}
              <div className="mt-3 flex flex-wrap gap-1.5" aria-label="Finding feedback">
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
            </article>
          ))}
        </div>
      )}
    </>
  );
}
