import { useSuspenseQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import { agentsQuery } from '../lib/queries.ts';
import { EmptyState, PageTitle } from '../components/section.tsx';
import { Pill } from '../components/ui/pill.tsx';

// One flat list — agents are generic: any agent can be enabled on any repo
// (settings), regardless of which organization the repo lives in.
export function AgentsPage() {
  const { data } = useSuspenseQuery(agentsQuery);

  return (
    <>
      <PageTitle
        aside={
          <Link to="/agents/new" className="text-[0.85rem] text-accent-bright hover:underline">
            + new agent
          </Link>
        }
      >
        agents
      </PageTitle>
      <p className="mt-3 text-[0.85rem] text-mute">
        Agents review the factory's generated PRs on the repos they're enabled for (see{' '}
        <Link to="/settings" className="text-accent-bright hover:underline">
          settings
        </Link>
        ) — their blocking findings drive the auto-fix loop. Any agent can be enabled on any repo.
      </p>

      {data.agents.length === 0 ? (
        <div className="mt-6">
          <EmptyState>No agents yet — install the app on GitHub first.</EmptyState>
        </div>
      ) : (
        <div className="mt-6 flex flex-col gap-2.5">
          {data.agents.map((a) => (
            <Link
              key={a.id}
              to="/agents/$agentId/edit"
              params={{ agentId: String(a.id) }}
              className="flex items-center justify-between gap-3 rounded-xl bg-raised/50 p-3.5 transition-colors hover:bg-raised active:scale-[0.99]"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[0.9rem] font-medium">{a.name}</span>
                  <Pill>{a.slug}</Pill>
                  {a.is_builtin ? <Pill className="text-mute/70">built-in</Pill> : null}
                </div>
                {a.description ? (
                  <p className="mt-1 truncate text-xs text-mute">{a.description}</p>
                ) : null}
                <p className="mt-0.5 font-mono text-xs text-mute/70">
                  {a.model.replace('cloudflare/', '')}
                </p>
              </div>
              <ChevronRight className="size-4 shrink-0 text-mute" aria-hidden />
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
