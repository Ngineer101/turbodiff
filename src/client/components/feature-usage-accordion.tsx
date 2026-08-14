import type { ApiFeatureUsage, ApiFeatureUsageSession } from '../../shared/api-types.ts';
import { fmtDuration, fmtTokens, fmtUsd, sentence } from '../lib/format.ts';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from './ui/accordion.tsx';
import { Muted } from './section.tsx';
import { Pill, type PillProps } from './ui/pill.tsx';
import { Table, Td, Th } from './ui/table.tsx';

const FEATURE_STATUS_TONE: Record<string, PillProps['tone']> = {
  queued: 'running',
  generating: 'running',
  pr_opened: 'on',
  merged: 'on',
  no_changes: 'red',
  failed: 'red',
  checks_failed: 'red',
  abandoned: 'red',
  pr_closed: 'neutral',
};

const SESSION_KIND_LABEL: Record<ApiFeatureUsageSession['kind'], string> = {
  generate: 'Generate',
  review: 'Review',
  fix: 'Fix',
  verify: 'Verify',
};

const SESSION_TONE: Record<string, PillProps['tone']> = {
  running: 'running',
  completed: 'on',
  passed: 'on',
  fixed: 'on',
  pr_opened: 'on',
  merged: 'on',
  failed: 'red',
  error: 'red',
  checks_failed: 'red',
  tests_failed: 'red',
  stalled: 'red',
};

function sessionTone(status: string): PillProps['tone'] {
  return SESSION_TONE[status] ?? 'neutral';
}

// One shipped feature's accordion row: title/repo/status/PR up top, every
// generation/review/fix/verify session it went through inside — zero-cost
// sessions render "—", same as ReviewsTable.
export function FeatureUsageAccordion({ features }: { features: ApiFeatureUsage[] }) {
  return (
    <Accordion type="multiple">
      {features.map((f) => (
        <AccordionItem key={f.id} value={String(f.id)}>
          <AccordionTrigger aside={<span className="font-mono">{fmtUsd(f.total_cost_usd)}</span>}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 truncate font-medium">{f.title}</span>
              <Pill tone={FEATURE_STATUS_TONE[f.status] ?? 'neutral'}>{sentence(f.status)}</Pill>
            </div>
            <div className="mt-0.5 text-xs text-mute">
              {f.repo ? <span className="font-mono">{f.repo}</span> : <Muted>(removed repo)</Muted>}
              {f.pr_url ? (
                <>
                  {' '}
                  ·{' '}
                  <a
                    href={f.pr_url}
                    target="_blank"
                    rel="noopener"
                    onClick={(e) => e.stopPropagation()}
                    className="text-accent-bright hover:underline"
                  >
                    PR #{f.pr_number}
                  </a>
                </>
              ) : null}
            </div>
          </AccordionTrigger>
          <AccordionContent>
            {f.sessions.length === 0 ? (
              <Muted>No sessions recorded yet.</Muted>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Session</Th>
                    <Th>Status</Th>
                    <Th numeric>Tokens</Th>
                    <Th numeric>Cost</Th>
                    <Th numeric>Time</Th>
                  </tr>
                </thead>
                <tbody>
                  {f.sessions.map((s, i) => (
                    <tr key={i}>
                      <Td>
                        {SESSION_KIND_LABEL[s.kind]}
                        {s.url ? (
                          <>
                            {' '}
                            ·{' '}
                            <a
                              href={s.url}
                              target="_blank"
                              rel="noopener"
                              className="text-accent-bright hover:underline"
                            >
                              {s.label}
                            </a>
                          </>
                        ) : (
                          <span className="text-mute"> · {s.label}</span>
                        )}
                      </Td>
                      <Td>
                        <Pill tone={sessionTone(s.status)}>{sentence(s.status)}</Pill>
                      </Td>
                      <Td numeric>
                        {s.total_tokens > 0 ? fmtTokens(s.total_tokens) : <Muted>—</Muted>}
                      </Td>
                      <Td numeric>{s.cost_usd > 0 ? fmtUsd(s.cost_usd) : <Muted>—</Muted>}</Td>
                      <Td numeric>
                        {s.duration_s !== null ? fmtDuration(s.duration_s) : <Muted>—</Muted>}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  );
}
