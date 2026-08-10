import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import { toast } from 'sonner';
import { api, ApiError } from '../lib/api.ts';
import { agentsQuery } from '../lib/queries.ts';
import { AgentForm, type AgentFormValues } from '../components/agent-form.tsx';
import { PageTitle, SectionHeading } from '../components/section.tsx';

// Default model mirrors src/lib/personas.ts; the server substitutes it when
// the field is blank and validates the final value either way.
const DEFAULT_MODEL_HINT = 'cloudflare/anthropic/claude-sonnet-5';

export function AgentNewPage() {
  const { installation } = useSearch({ from: '/agents/new' });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data } = useSuspenseQuery(agentsQuery);
  const [error, setError] = useState<string | null>(null);
  const account = data.installations.find((i) => i.id === installation)?.account_login;

  const create = useMutation({
    mutationFn: (values: AgentFormValues) =>
      api.post(`/api/agents?installation=${installation}`, values),
    onSuccess: () => {
      toast.success('agent created');
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      navigate({ to: '/agents' });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'request failed'),
  });

  return (
    <>
      <PageTitle>agents</PageTitle>
      <SectionHeading>new agent{account ? ` — ${account}` : ''}</SectionHeading>
      <AgentForm
        initial={{
          name: '',
          slug: '',
          description: '',
          instructions: '',
          model: DEFAULT_MODEL_HINT,
        }}
        slugEditable
        defaultModel={DEFAULT_MODEL_HINT}
        error={error}
        busy={create.isPending}
        onSubmit={(values) => create.mutate(values)}
        onCancel={() => navigate({ to: '/agents' })}
      />
    </>
  );
}
