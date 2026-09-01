import { useSuspenseQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Clock, Plus } from 'lucide-react';
import type { ApiAutomationSummary } from '../../shared/api-types.ts';
import { ago, sentence } from '../lib/format.ts';
import { automationsQuery } from '../lib/queries.ts';
import { EntityCard, EntityGrid, EntityListHeader } from '../components/entity-list.tsx';
import { EmptyState } from '../components/section.tsx';
import { buttonVariants } from '../components/ui/button.tsx';
import { Pill, type PillProps } from '../components/ui/pill.tsx';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function scheduleSummary(a: ApiAutomationSummary): string {
  if (a.schedule_kind === 'hourly') return 'Hourly';
  if (a.schedule_kind === 'daily') return `Daily · ${a.time_of_day} UTC`;
  const day = a.day_of_week !== null ? DAY_NAMES[a.day_of_week] : '?';
  return `Weekly · ${day} ${a.time_of_day} UTC`;
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
    <div className="animate-rise">
      <EntityListHeader
        kind="automation"
        title="Automations"
        description="A recurring prompt that runs on a schedule against one repo and opens a PR when it makes changes — every firing is logged, even when nothing changes."
        action={
          <Link
            to="/automations/new"
            className={buttonVariants({ variant: 'default', size: 'default' })}
          >
            <Plus className="size-4" aria-hidden /> New automation
          </Link>
        }
      />

      {data.automations.length === 0 ? (
        <div className="mt-6">
          <EmptyState>No automations yet — create one to get started.</EmptyState>
        </div>
      ) : (
        <EntityGrid>
          {data.automations.map((a) => (
            <Link
              key={a.id}
              to="/automations/$automationId/edit"
              params={{ automationId: String(a.id) }}
              className="block active:scale-[0.99]"
            >
              <EntityCard
                kind="automation"
                slug={a.name}
                name={a.name}
                interactive
                chips={a.enabled ? undefined : <Pill tone="warn">Disabled</Pill>}
                meta={
                  <>
                    <Pill>
                      {a.repository.owner}/{a.repository.name}
                    </Pill>
                    <span className="inline-flex items-center gap-1">
                      <Clock className="size-3" aria-hidden />
                      {scheduleSummary(a)}
                    </span>
                    <LastRunPill lastRun={a.last_run} />
                  </>
                }
              />
            </Link>
          ))}
        </EntityGrid>
      )}
    </div>
  );
}
