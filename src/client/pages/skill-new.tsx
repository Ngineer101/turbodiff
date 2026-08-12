import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { toast } from 'sonner';
import { api, ApiError } from '../lib/api.ts';
import { SkillForm, type SkillFormValues } from '../components/skill-form.tsx';
import { PageTitle, SectionHeading } from '../components/section.tsx';

// Skills are generic — the server creates the skill for every installation,
// so no organization picker is needed here.
export function SkillNewPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: (values: SkillFormValues) => api.post('/api/skills', values),
    onSuccess: () => {
      toast.success('skill created');
      void queryClient.invalidateQueries({ queryKey: ['skills'] });
      void navigate({ to: '/skills' });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'request failed'),
  });

  return (
    <>
      <PageTitle>skills</PageTitle>
      <SectionHeading>new skill</SectionHeading>
      <SkillForm
        initial={{ name: '', slug: '', description: '', instructions: '' }}
        slugEditable
        error={error}
        busy={create.isPending}
        onSubmit={(values) => create.mutate(values)}
        onCancel={() => navigate({ to: '/skills' })}
      />
    </>
  );
}
