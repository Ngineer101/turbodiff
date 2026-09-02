import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { toast } from 'sonner';
import { api, ApiError } from '../lib/api.ts';
import { modelsQuery } from '../lib/queries.ts';
import { AgentForm, type AgentFormValues } from '../components/agent-form.tsx';

// Agents are generic — the server creates the agent for every installation,
// so no organization picker is needed here.
export function AgentNewPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: models } = useSuspenseQuery(modelsQuery);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: (values: AgentFormValues) => api.post('/api/agents', values),
    onSuccess: () => {
      toast.success('Agent created');
      void queryClient.invalidateQueries({ queryKey: ['agents'] });
      void navigate({ to: '/agents' });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Request failed'),
  });

  return (
    <AgentForm
      mode="new"
      initial={{
        name: '',
        slug: '',
        description: '',
        instructions: '',
        model: models.reviewer.default_model,
      }}
      slugEditable
      models={models.reviewer.options}
      defaultModel={models.reviewer.default_model}
      error={error}
      busy={create.isPending}
      onSubmit={(values) => create.mutate(values)}
      onCancel={() => navigate({ to: '/agents' })}
    />
  );
}
