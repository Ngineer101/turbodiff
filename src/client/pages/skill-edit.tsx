import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api, ApiError } from '../lib/api.ts';
import { skillQuery } from '../lib/queries.ts';
import { SkillForm, type SkillFormValues } from '../components/skill-form.tsx';
import { ConfirmButton } from '../components/confirm-button.tsx';

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
