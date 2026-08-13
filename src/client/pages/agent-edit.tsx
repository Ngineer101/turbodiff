import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { toast } from 'sonner';
import { api, ApiError } from '../lib/api.ts';
import { agentQuery } from '../lib/queries.ts';
import { AgentForm, type AgentFormValues } from '../components/agent-form.tsx';
import { ConfirmButton } from '../components/confirm-button.tsx';
import { Muted, PageTitle, SectionHeading } from '../components/section.tsx';
import { Pill } from '../components/ui/pill.tsx';

function onApiError(err: unknown) {
  toast.error(err instanceof ApiError ? err.message : 'Request failed');
}

export function AgentEditPage() {
  const { agentId } = useParams({ from: '/agents/$agentId/edit' });
  const id = Number(agentId);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data } = useSuspenseQuery(agentQuery(id));
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
    <>
      <PageTitle aside={data.agent.is_builtin ? <Pill>Built-in</Pill> : undefined}>
        Edit agent
      </PageTitle>
      <AgentForm
        initial={{
          name: data.agent.name,
          slug: data.agent.slug,
          description: data.agent.description ?? '',
          instructions: data.agent.instructions,
          model: data.agent.model,
        }}
        slugEditable={false}
        defaultModel={data.default_model}
        error={error}
        busy={save.isPending}
        onSubmit={(values) => save.mutate(values)}
        onCancel={() => navigate({ to: '/agents' })}
      />
      {!data.agent.is_builtin ? (
        <div className="mt-6 border-t border-line pt-4">
          <ConfirmButton
            variant="danger"
            title="Delete this agent?"
            description="Its review history stays. This cannot be undone."
            confirmLabel="Delete agent"
            onConfirm={() => remove.mutate()}
            busy={remove.isPending}
          >
            Delete agent
          </ConfirmButton>
        </div>
      ) : null}
      <SectionHeading aside={<Muted>MCP</Muted>}>Attached integrations</SectionHeading>
      {data.connections.length === 0 ? (
        <Muted className="block">None attached.</Muted>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {data.connections.map((conn) => (
            <Pill key={conn.id}>{conn.name}</Pill>
          ))}
        </div>
      )}
      <p className="mt-2 text-xs text-mute">
        Connections are managed centrally on the{' '}
        <Link to="/integrations" className="text-accent-bright hover:underline">
          MCP &amp; integrations
        </Link>{' '}
        page — attach or detach this agent there.
      </p>
    </>
  );
}
