import { useSuspenseQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { agentsQuery } from '../lib/queries.ts';
import { EntityCard, EntityGrid, EntityListHeader } from '../components/entity-list.tsx';
import { EmptyState } from '../components/section.tsx';
import { buttonVariants } from '../components/ui/button.tsx';
import { Pill } from '../components/ui/pill.tsx';

// One flat list — agents are generic: any agent can be enabled on any repo
// (settings), regardless of which organization the repo lives in.
export function AgentsPage() {
  const { data } = useSuspenseQuery(agentsQuery);

  return (
    <div className="animate-rise">
      <EntityListHeader
        kind="agent"
        title="Agents"
        description={
          <>
            Agents review the factory's generated PRs on the repos they're enabled for (
            <Link to="/settings" className="text-accent-bright hover:underline">
              Settings
            </Link>
            ) — their blocking findings drive the auto-fix loop.
          </>
        }
        action={
          <Link to="/agents/new" className={buttonVariants({ variant: 'default', size: 'default' })}>
            <Plus className="size-4" aria-hidden /> New agent
          </Link>
        }
      />

      {data.agents.length === 0 ? (
        <div className="mt-6">
          <EmptyState>No agents yet — install the app on GitHub first.</EmptyState>
        </div>
      ) : (
        <EntityGrid>
          {data.agents.map((a) => (
            <Link
              key={a.id}
              to="/agents/$agentId/edit"
              params={{ agentId: String(a.id) }}
              className="block active:scale-[0.99]"
            >
              <EntityCard
                kind="agent"
                slug={a.slug}
                name={a.name}
                interactive
                chips={
                  <>
                    <Pill>{a.slug}</Pill>
                    {a.is_builtin ? <Pill className="text-mute/70">Built-in</Pill> : null}
                  </>
                }
                description={a.description ?? undefined}
                meta={<span className="font-mono text-mute/70">{a.model.replace('cloudflare/', '')}</span>}
              />
            </Link>
          ))}
        </EntityGrid>
      )}
    </div>
  );
}
