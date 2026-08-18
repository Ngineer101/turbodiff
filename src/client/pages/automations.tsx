import { useSuspenseQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import type { ApiAutomationSummary } from '../../shared/api-types.ts';
import { ago, sentence } from '../lib/format.ts';
import { automationsQuery } from '../lib/queries.ts';
import { EmptyState, PageTitle } from '../components/section.tsx';
import { Pill, type PillProps } from '../components/ui/pill.tsx';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function scheduleSummary(a: ApiAutomationSummary): string {
  if (a.schedule_kind === 'hourly') return 'hourly';
  if (a.schedule_kind === 'daily') return `daily at ${a.time_of_day} UTC`;
  const day = a.day_of_week !== null ? DAY_NAMES[a.day_of_week] : '?';
  return `weekly on ${day} at ${a.time_of_day} UTC`;
}

const STATUS_TONE = {
  running: 'running',
  pr_opened: 'on',
  no_changes: 'neutral',
  checks_failed: 'warn',
  failed: 'red',
} satisfies Record<string, PillProps['tone']>;

function isKnownStatus(status: string): status is keyof typeof STATUS_TONE {
  return status in STATUS_TONE;
}

function LastRunPill({ lastRun }: { lastRun: ApiAutomationSummary['last_run'] }) {
  if (!lastRun) return <Pill>No runs yet</Pill>;
  return (
    <Pill tone={isKnownStatus(lastRun.status) ? STATUS_TONE[lastRun.status] : 'neutral'}>
      {sentence(lastRun.status)} · {ago(lastRun.created_at)}
    </Pill>
  );
}

// One flat list — an automation belongs to exactly one repo, but the page
// spans every repo the caller can manage, like the board.
export function AutomationsPage() {
  const { data } = useSuspenseQuery(automationsQuery);

  return (
    <>
      <PageTitle
        aside={
          <Link to="/automations/new" className="text-[0.85rem] text-accent-bright hover:underline">
            + new automation
          </Link>
        }
      >
        automations
      </PageTitle>
      <p className="mt-3 text-[0.85rem] text-mute">
        A recurring prompt that runs on a schedule against one repo and opens a PR when it makes
        changes — every firing is logged, even when nothing changes.
      </p>

      {data.automations.length === 0 ? (
        <div className="mt-6">
          <EmptyState>No automations yet — create one to get started.</EmptyState>
        </div>
      ) : (
        <div className="mt-6 flex flex-col gap-2.5">
          {data.automations.map((a) => (
            <Link
              key={a.id}
              to="/automations/$automationId/edit"
              params={{ automationId: String(a.id) }}
              className="flex items-center justify-between gap-3 rounded-xl bg-raised/50 p-3.5 transition-colors hover:bg-raised active:scale-[0.99]"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[0.9rem] font-medium">{a.name}</span>
                  {a.enabled ? null : <Pill tone="warn">Disabled</Pill>}
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-mute">
                  <Pill>
                    {a.repository.owner}/{a.repository.name}
                  </Pill>
                  <span>{scheduleSummary(a)}</span>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <LastRunPill lastRun={a.last_run} />
                <ChevronRight className="size-4 shrink-0 text-mute" aria-hidden />
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
