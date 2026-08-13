import type { ApiReview } from '../../shared/api-types.ts';
import { ago, fmtDuration, fmtTokens, fmtUsd } from '../lib/format.ts';
import { Muted } from './section.tsx';
import { Pill } from './ui/pill.tsx';
import { Table, Td, Th } from './ui/table.tsx';

export function ReviewStatePill({ review }: { review: ApiReview }) {
  if (review.state === 'running') return <Pill tone="running">Reviewing</Pill>;
  if (review.state === 'stalled') return <Pill tone="red">Stalled</Pill>;
  if (review.state === 'failed') return <Pill tone="red">Failed</Pill>;
  return review.review_url ? (
    <a href={review.review_url} target="_blank" rel="noopener">
      <Pill className="hover:border-accent/40 hover:text-accent-bright">Done &rarr;</Pill>
    </a>
  ) : (
    <Pill>Done</Pill>
  );
}

// PR · status · tokens · cost · duration · age. Zero-usage rows (predating
// metering, or not yet metered) render as "—".
export function ReviewsTable({ reviews }: { reviews: ApiReview[] }) {
  return (
    <Table>
      <thead>
        <tr>
          <Th>Pull request</Th>
          <Th>Status</Th>
          <Th numeric>Tokens</Th>
          <Th numeric>Cost</Th>
          <Th numeric>Time</Th>
          <Th numeric>When</Th>
        </tr>
      </thead>
      <tbody>
        {reviews.map((r) => (
          <tr key={r.id}>
            <Td>
              {r.pr_url ? (
                <a
                  href={r.pr_url}
                  target="_blank"
                  rel="noopener"
                  className="font-mono text-accent-bright hover:underline"
                >
                  {r.repo}#{r.pr_number}
                </a>
              ) : (
                <span className="font-mono">(removed repository)#{r.pr_number}</span>
              )}
              <div className="text-xs text-mute">
                {r.agent_slug ?? 'review'} · {r.trigger_event}
                {r.risk_tier ? <> · {r.risk_tier}</> : null}
                {r.findings_count !== null ? (
                  <>
                    {' '}
                    · {r.findings_count} finding{r.findings_count === 1 ? '' : 's'}
                  </>
                ) : null}
              </div>
            </Td>
            <Td>
              <ReviewStatePill review={r} />
            </Td>
            <Td numeric>{r.total_tokens > 0 ? fmtTokens(r.total_tokens) : <Muted>—</Muted>}</Td>
            <Td numeric>{r.cost_usd > 0 ? fmtUsd(r.cost_usd) : <Muted>—</Muted>}</Td>
            <Td numeric>{r.duration_s !== null ? fmtDuration(r.duration_s) : <Muted>—</Muted>}</Td>
            <Td numeric className="text-mute">
              {ago(r.created_at)}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
