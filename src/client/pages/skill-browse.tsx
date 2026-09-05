import { useMutation, useSuspenseQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowLeft, Link2, Search } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import type { ApiSkillCatalogEntry, ApiSkillImportPreview } from '../../shared/api-types.ts';
import { api, ApiError } from '../lib/api.ts';
import { skillCatalogQuery } from '../lib/queries.ts';
import { EntityCard, EntityGrid, EntityListHeader } from '../components/entity-list.tsx';
import { EmptyState } from '../components/section.tsx';
import { SkillImportDialog } from '../components/skill-import-dialog.tsx';
import { Button, buttonVariants } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Pill } from '../components/ui/pill.tsx';
import { cn } from '../lib/utils.ts';

const SORTS = [
  { id: 'trending', label: 'Trending' },
  { id: 'all-time', label: 'All-time' },
  { id: 'hot', label: 'Hot' },
] as const;

// Browse the skills.sh catalog (when the server has a token) and import a
// skill — always via the mandatory preview dialog. Without a token the page
// still offers the paste-a-reference import path (GitHub-direct).
export function SkillBrowsePage() {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [sort, setSort] = useState<string>('trending');
  const [reference, setReference] = useState('');
  const [preview, setPreview] = useState<{
    reference: string;
    result: ApiSkillImportPreview;
  } | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const { data } = useSuspenseQuery(skillCatalogQuery(debouncedQuery, sort));

  const loadPreview = useMutation({
    mutationFn: (ref: string) =>
      api
        .post<ApiSkillImportPreview, { reference: string }>('/api/skills/import/preview', {
          reference: ref,
        })
        .then((result) => ({ reference: ref, result })),
    onSuccess: setPreview,
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'request failed'),
  });

  const submitReference = (e: FormEvent) => {
    e.preventDefault();
    if (reference.trim()) loadPreview.mutate(reference.trim());
  };

  const importForm = (
    <form onSubmit={submitReference} className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-0 flex-1 sm:max-w-md">
        <Link2
          className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-mute"
          aria-hidden
        />
        <Input
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          placeholder="skills.sh or GitHub folder URL, or owner/repo/skill"
          aria-label="Skill reference"
          className="pl-8 sm:pl-8"
        />
      </div>
      <Button type="submit" variant="secondary" loading={loadPreview.isPending}>
        Preview
      </Button>
    </form>
  );

  return (
    <div className="animate-rise">
      <EntityListHeader
        kind="skill"
        title="Browse skills"
        description="Search skills.sh and import a skill as an editable copy — review its instructions and files before importing."
        action={
          <Link to="/skills" className={buttonVariants({ variant: 'secondary', size: 'default' })}>
            <ArrowLeft className="size-4" aria-hidden /> Skills
          </Link>
        }
      />

      {data.configured ? (
        <>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <div className="relative min-w-0 flex-1 sm:max-w-sm">
              <Search
                className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-mute"
                aria-hidden
              />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search skills.sh…"
                aria-label="Search skills.sh"
                className="pl-8 sm:pl-8"
              />
            </div>
            {debouncedQuery === '' ? (
              <div className="flex items-center gap-1">
                {SORTS.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setSort(s.id)}
                    className={cn(
                      'cursor-pointer rounded-full border px-2.5 py-px font-mono text-xs',
                      sort === s.id
                        ? 'border-accent/40 text-accent'
                        : 'border-line-2 text-mute hover:text-ink',
                    )}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          {data.error ? (
            <div className="mt-6">
              <EmptyState>
                The skills.sh catalog is unavailable right now — importing from a URL below still
                works.
              </EmptyState>
            </div>
          ) : data.skills.length === 0 ? (
            <div className="mt-6">
              <EmptyState>
                {debouncedQuery
                  ? `No skills.sh results for “${debouncedQuery}”.`
                  : 'The skills.sh catalog returned nothing — try a search.'}
              </EmptyState>
            </div>
          ) : (
            <EntityGrid>
              {data.skills.map((s: ApiSkillCatalogEntry) => (
                <button
                  key={`${s.source}/${s.slug}`}
                  type="button"
                  onClick={() => loadPreview.mutate(`${s.source}/${s.slug}`)}
                  disabled={loadPreview.isPending}
                  className="block w-full cursor-pointer text-left active:scale-[0.99] disabled:opacity-60"
                >
                  <EntityCard
                    kind="skill"
                    slug={s.slug}
                    name={s.name}
                    interactive
                    chips={<Pill>{s.source}</Pill>}
                    description={s.description ?? undefined}
                    meta={
                      s.installs !== null ? (
                        <span className="tabular-nums">{s.installs.toLocaleString()} installs</span>
                      ) : undefined
                    }
                  />
                </button>
              ))}
            </EntityGrid>
          )}

          <div className="mt-8 border-t border-line/70 pt-4">
            <p className="mb-2 text-xs text-mute">
              Or import directly from a URL (works for any public GitHub skill folder):
            </p>
            {importForm}
          </div>
        </>
      ) : (
        <div className="mt-6 space-y-4">
          <EmptyState>
            skills.sh search isn't configured — set the SKILLS_SH_API_TOKEN secret to browse the
            catalog here. Importing from a URL works without it.
          </EmptyState>
          {importForm}
        </div>
      )}

      {preview ? (
        <SkillImportDialog
          reference={preview.reference}
          preview={preview.result}
          onClose={() => setPreview(null)}
        />
      ) : null}
    </div>
  );
}
