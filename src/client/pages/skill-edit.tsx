import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api, ApiError } from '../lib/api.ts';
import { skillQuery } from '../lib/queries.ts';
import { SkillForm, type SkillFormValues } from '../components/skill-form.tsx';
import { ConfirmButton } from '../components/confirm-button.tsx';
import { Pill } from '../components/ui/pill.tsx';

function onApiError<T>(err: T) {
  toast.error(err instanceof ApiError ? err.message : 'request failed');
}

export function SkillEditPage() {
  const { skillId } = useParams({ from: '/shell/skills/$skillId/edit' });
  const id = Number(skillId);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data } = useSuspenseQuery(skillQuery(id));
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (values: SkillFormValues) => api.put(`/api/skills/${id}`, values),
    onSuccess: () => {
      toast.success('skill saved');
      queryClient.invalidateQueries({ queryKey: ['skills'] });
      queryClient.invalidateQueries({ queryKey: ['skill', id] });
      navigate({ to: '/skills' });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'request failed'),
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/api/skills/${id}`),
    onSuccess: () => {
      toast.success('skill deleted');
      queryClient.invalidateQueries({ queryKey: ['skills'] });
      navigate({ to: '/skills' });
    },
    onError: onApiError,
  });

  const skill = data.skill;
  const provenance =
    skill.source !== null ? (
      <div className="space-y-2 text-xs text-mute">
        <p className="flex flex-wrap items-center gap-2">
          <Pill tone="on">{skill.source}</Pill>
          {skill.source_ref ? <span className="font-mono break-all">{skill.source_ref}</span> : null}
          {skill.source_hash ? (
            <span className="font-mono">{skill.source_hash.slice(0, 12)}</span>
          ) : null}
          {skill.imported_at ? (
            <span>imported {new Date(skill.imported_at).toLocaleDateString()}</span>
          ) : null}
        </p>
        {skill.files.length > 0 ? (
          <ul className="rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-[11px] leading-relaxed text-ink-dim">
            {skill.files.map((f) => (
              <li key={f.path} className="truncate">
                {f.path}
              </li>
            ))}
          </ul>
        ) : null}
        <p>Imported copy — edits here don't sync upstream.</p>
      </div>
    ) : undefined;

  return (
    <SkillForm
      mode="edit"
      initial={{
        name: data.skill.name,
        slug: data.skill.slug,
        description: data.skill.description ?? '',
        instructions: data.skill.instructions,
      }}
      slugEditable={false}
      provenance={provenance}
      error={error}
      busy={save.isPending}
      onSubmit={(values) => save.mutate(values)}
      onCancel={() => navigate({ to: '/skills' })}
      footerAction={
        <ConfirmButton
          variant="danger"
          title="Delete this skill?"
          description="This cannot be undone."
          confirmLabel="Delete skill"
          onConfirm={() => remove.mutate()}
          busy={remove.isPending}
        >
          <Trash2 className="size-4" aria-hidden /> Delete skill
        </ConfirmButton>
      }
    />
  );
}
