import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { toast } from 'sonner';
import { api, ApiError } from '../lib/api.ts';
import { automationsQuery } from '../lib/queries.ts';
import { AutomationForm, type AutomationSubmitValues } from '../components/automation-form.tsx';

export function AutomationNewPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data } = useSuspenseQuery(automationsQuery);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: (values: AutomationSubmitValues) => api.post('/api/automations', values),
    onSuccess: () => {
      toast.success('automation created');
      void queryClient.invalidateQueries({ queryKey: ['automations'] });
      void navigate({ to: '/automations' });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'request failed'),
  });

  return (
    <AutomationForm
      mode="new"
      initial={{
          name: '',
          repository_id: data.repos[0]?.id ?? 0,
          prompt: '',
          schedule_kind: 'daily',
          time_of_day: '09:00',
          day_of_week: 1,
          enabled: true,
        }}
        repos={data.repos}
        repoEditable
        showEnabled={false}
        error={error}
        busy={create.isPending}
        onSubmit={(values) => create.mutate(values)}
        onCancel={() => navigate({ to: '/automations' })}
      />
  );
}
