import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api, ApiError } from '../lib/api.ts';
import { agentQuery, modelsQuery } from '../lib/queries.ts';
import { AgentForm, type AgentFormValues } from '../components/agent-form.tsx';
import { ConfirmButton } from '../components/confirm-button.tsx';

function onApiError<T>(err: T) {
  toast.error(err instanceof ApiError ? err.message : 'Request failed');
}

export function AgentEditPage() {
  const { agentId } = useParams({ from: '/shell/agents/$agentId/edit' });
  const id = Number(agentId);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data } = useSuspenseQuery(agentQuery(id));
  const { data: models } = useSuspenseQuery(modelsQuery);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (values: AgentFormValues) => api.put(`/api/agents/${id}`, values),
    onSuccess: () => {
      toast.success('Agent saved');
      void queryClient.invalidateQueries({ queryKey: ['agents'] });
      void queryClient.invalidateQueries({ queryKey: ['agent', id] });
      void navigate({ to: '/agents' });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Request failed'),
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/api/agents/${id}`),
    onSuccess: () => {
      toast.success('Agent deleted — its review history stays');
      void queryClient.invalidateQueries({ queryKey: ['agents'] });
      void navigate({ to: '/agents' });
    },
    onError: onApiError,
  });

  return (
    <AgentForm
      mode="edit"
      initial={{
        name: data.agent.name,
        slug: data.agent.slug,
        description: data.agent.description ?? '',
        instructions: data.agent.instructions,
        model: data.agent.model,
      }}
      slugEditable={false}
      models={models.reviewer.options}
      defaultModel={data.default_model}
      error={error}
      busy={save.isPending}
      onSubmit={(values) => save.mutate(values)}
      onCancel={() => navigate({ to: '/agents' })}
      footerAction={
        data.agent.is_builtin ? undefined : (
          <ConfirmButton
            variant="danger"
            title="Delete this agent?"
            description="Its review history stays. This cannot be undone."
            confirmLabel="Delete agent"
            onConfirm={() => remove.mutate()}
            busy={remove.isPending}
          >
            <Trash2 className="size-4" aria-hidden /> Delete agent
          </ConfirmButton>
        )
      }
    />
  );
}
