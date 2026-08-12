import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { ApiAgentRun } from '../../shared/api-types.ts';
import { ago } from '../lib/format.ts';
import { agentRunLogQuery } from '../lib/queries.ts';
import { SectionHeading } from './section.tsx';

// Collapsed per-run session log — the full stdout+stderr of one sandboxed
// agent-CLI invocation. Not fetched until the user expands it: most runs are
// never inspected, and the transcripts can be large.
const KIND_LABEL: Record<ApiAgentRun['kind'], string> = {
  plan_analyze: 'plan analyze',
  plan_refine: 'plan refine',
  generate: 'generate',
  verify: 'verify',
  fix: 'fix',
};

function AgentRunEntry({ run }: { run: ApiAgentRun }) {
  const [open, setOpen] = useState(false);
  const { data, isLoading, isError } = useQuery({ ...agentRunLogQuery(run.id), enabled: open });
  return (
    <details
      className="mt-2 rounded-lg border border-line bg-surface px-3 py-2"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="cursor-pointer text-[0.85rem] text-mute">
        {run.success ? '✅' : '❌'} {KIND_LABEL[run.kind]} · {ago(run.created_at)}
      </summary>
      {open ? (
        isLoading ? (
          <p className="mt-2 text-xs text-mute">loading…</p>
        ) : isError ? (
          <p className="mt-2 text-xs text-danger">failed to load log</p>
        ) : (
          <pre className="mt-2 max-h-96 overflow-auto rounded-md border border-line-2 bg-raised/40 p-2.5 text-xs whitespace-pre-wrap">
            {data?.log}
          </pre>
        )
      ) : null}
    </details>
  );
}

export function AgentRunLog({ runs }: { runs: ApiAgentRun[] }) {
  if (runs.length === 0) return null;
  return (
    <>
      <SectionHeading>session logs</SectionHeading>
      {runs.map((r) => (
        <AgentRunEntry key={r.id} run={r} />
      ))}
    </>
  );
}
