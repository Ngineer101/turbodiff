import { useSuspenseQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import { skillsQuery } from '../lib/queries.ts';
import { EmptyState, PageTitle } from '../components/section.tsx';
import { Pill } from '../components/ui/pill.tsx';

// One flat list — skills are generic: any skill can be enabled on any repo
// (settings), regardless of which organization the repo lives in.
export function SkillsPage() {
  const { data } = useSuspenseQuery(skillsQuery);

  return (
    <>
      <PageTitle
        aside={
          <Link to="/skills/new" className="text-[0.85rem] text-accent-bright hover:underline">
            + new skill
          </Link>
        }
      >
        skills
      </PageTitle>
      <p className="mt-3 text-[0.85rem] text-mute">
        Skills give code generation and fix runs extra abilities — enable per repo in{' '}
        <Link to="/settings" className="text-accent-bright hover:underline">
          settings
        </Link>
        . Any skill can be enabled on any repo.
      </p>

      {data.skills.length === 0 ? (
        <div className="mt-6">
          <EmptyState>No skills yet — create one to get started.</EmptyState>
        </div>
      ) : (
        <div className="mt-6 flex flex-col gap-2.5">
          {data.skills.map((s) => (
            <Link
              key={s.id}
              to="/skills/$skillId/edit"
              params={{ skillId: String(s.id) }}
              className="flex items-center justify-between gap-3 rounded-xl bg-raised/50 p-3.5 transition-colors hover:bg-raised active:scale-[0.99]"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[0.9rem] font-medium">{s.name}</span>
                  <Pill>{s.slug}</Pill>
                </div>
                {s.description ? (
                  <p className="mt-1 truncate text-xs text-mute">{s.description}</p>
                ) : null}
              </div>
              <ChevronRight className="size-4 shrink-0 text-mute" aria-hidden />
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
