import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { ApiAgentRun } from '../../shared/api-types.ts';
import { ago } from '../lib/format.ts';
import { agentRunLogQuery } from '../lib/queries.ts';
import { SectionHeading } from './section.tsx';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from './ui/accordion.tsx';

// Collapsed per-run session log — the full stdout+stderr of one sandboxed
// agent-CLI invocation. Not fetched until the user expands it: most runs are
// never inspected, and the transcripts can be large.
const KIND_LABEL: Record<ApiAgentRun['kind'], string> = {
  plan_analyze: 'Plan analyze',
  plan_refine: 'Plan refine',
  generate: 'Generate',
  verify: 'Verify',
  fix: 'Fix',
  automation: 'Automation',
  resolve_conflict: 'Resolve conflict',
};

function AgentRunEntry({ run, open }: { run: ApiAgentRun; open: boolean }) {
  const { data, isLoading, isError } = useQuery({ ...agentRunLogQuery(run.id), enabled: open });
  return (
    <>
      {isLoading ? (
        <p className="text-xs text-mute">Loading…</p>
      ) : isError ? (
        <p className="text-xs text-danger">Failed to load the log.</p>
      ) : (
        <pre className="max-h-96 overflow-auto rounded-md border border-line-2 bg-raised/40 p-2.5 text-xs whitespace-pre-wrap">
          {data?.log}
        </pre>
      )}
    </>
  );
}

export function AgentRunLog({ runs }: { runs: ApiAgentRun[] }) {
  // Track which entries have ever been opened so logs fetch lazily.
  const [open, setOpen] = useState<string[]>([]);
  if (runs.length === 0) return null;
  return (
    <>
      <SectionHeading>Session logs</SectionHeading>
      <Accordion type="multiple" value={open} onValueChange={setOpen}>
        {runs.map((r) => (
          <AccordionItem key={r.id} value={String(r.id)}>
            <AccordionTrigger
              aside={<span className="text-xs text-mute">{ago(r.created_at)}</span>}
            >
              <span
                className={r.success ? 'font-mono text-accent-bright' : 'font-mono text-danger'}
                aria-label={r.success ? 'succeeded' : 'failed'}
              >
                {r.success ? '✓' : '✗'}
              </span>{' '}
              {KIND_LABEL[r.kind]}
            </AccordionTrigger>
            <AccordionContent>
              <AgentRunEntry run={r} open={open.includes(String(r.id))} />
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </>
  );
}
