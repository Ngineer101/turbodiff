import { useSuspenseQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Plus, Search } from 'lucide-react';
import { skillsQuery } from '../lib/queries.ts';
import { EntityCard, EntityGrid, EntityListHeader } from '../components/entity-list.tsx';
import { EmptyState } from '../components/section.tsx';
import { buttonVariants } from '../components/ui/button.tsx';
import { Pill } from '../components/ui/pill.tsx';

// One flat list — skills are generic: any skill can be enabled on any repo
// (settings), regardless of which organization the repo lives in.
export function SkillsPage() {
  const { data } = useSuspenseQuery(skillsQuery);

  return (
    <div className="animate-rise">
      <EntityListHeader
        kind="skill"
        title="Skills"
        description={
          <>
            Skills give code generation and fix runs extra abilities — enable them per repo in{' '}
            <Link to="/settings" className="text-accent-bright hover:underline">
              settings
            </Link>
            .
          </>
        }
        action={
          <div className="flex flex-wrap gap-2">
            <Link
              to="/skills/browse"
              className={buttonVariants({ variant: 'secondary', size: 'default' })}
            >
              <Search className="size-4" aria-hidden /> Browse skills.sh
            </Link>
            <Link
              to="/skills/new"
              className={buttonVariants({ variant: 'default', size: 'default' })}
            >
              <Plus className="size-4" aria-hidden /> New skill
            </Link>
          </div>
        }
      />

      {data.skills.length === 0 ? (
        <div className="mt-6">
          <EmptyState>No skills yet — create one, or import one from skills.sh.</EmptyState>
        </div>
      ) : (
        <EntityGrid>
          {data.skills.map((s) => (
            <Link
              key={s.id}
              to="/skills/$skillId/edit"
              params={{ skillId: String(s.id) }}
              className="block active:scale-[0.99]"
            >
              <EntityCard
                kind="skill"
                slug={s.slug}
                name={s.name}
                interactive
                chips={
                  <>
                    <Pill>{s.slug}</Pill>
                    {s.source === 'skills.sh' ? <Pill tone="on">skills.sh</Pill> : null}
                    {s.source === 'github' ? <Pill>imported</Pill> : null}
                  </>
                }
                description={s.description ?? undefined}
              />
            </Link>
          ))}
        </EntityGrid>
      )}
    </div>
  );
}
