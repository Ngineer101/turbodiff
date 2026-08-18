import { useSuspenseQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { ago } from '../lib/format.ts';
import { automationRunQuery } from '../lib/queries.ts';
import { AgentRunLog } from '../components/agent-run-log.tsx';
import { PageTitle } from '../components/section.tsx';
import { buttonVariants } from '../components/ui/button.tsx';
import { Pill, type PillProps } from '../components/ui/pill.tsx';
import { cn } from '../lib/utils.ts';

const STATUS_TONE = {
  running: 'running',
  pr_opened: 'on',
  no_changes: 'neutral',
  checks_failed: 'warn',
  failed: 'red',
} satisfies Record<string, PillProps['tone']>;

export function AutomationRunPage() {
  const { runId } = useParams({ from: '/shell/automations/runs/$runId' });
  const id = Number(runId);
  const { data } = useSuspenseQuery(automationRunQuery(id));

  return (
    <>
      <PageTitle
        aside={
          <Link
            to="/automations/$automationId/edit"
            params={{ automationId: String(data.automation.id) }}
            className="text-[0.85rem] text-accent-bright hover:underline"
          >
            &larr; {data.automation.name}
          </Link>
        }
      >
        automation run #{data.run.id}
      </PageTitle>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Pill tone={STATUS_TONE[data.run.status] ?? 'neutral'}>
          {data.run.status.replaceAll('_', ' ')}
        </Pill>
        <span className="text-xs text-mute">{data.automation.repo}</span>
        <span className="text-xs text-mute">{ago(data.run.created_at)}</span>
      </div>

      {data.run.error ? <p className="mt-3 text-[0.85rem] text-danger">{data.run.error}</p> : null}

      {data.run.pr_number ? (
        <a
          href={`https://github.com/${data.automation.repo}/pull/${data.run.pr_number}`}
          target="_blank"
          rel="noopener"
          className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }), 'mt-4 w-fit')}
        >
          PR #{data.run.pr_number} on GitHub
        </a>
      ) : null}

      <AgentRunLog runs={data.runs} />
    </>
  );
}
