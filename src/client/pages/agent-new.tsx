import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { toast } from 'sonner';
import { api, ApiError } from '../lib/api.ts';
import { AgentForm, type AgentFormValues } from '../components/agent-form.tsx';
import { PageTitle, SectionHeading } from '../components/section.tsx';

// Default model mirrors src/domain/personas.ts; the server substitutes it when
// the field is blank and validates the final value either way.
const DEFAULT_MODEL_HINT = 'cloudflare/anthropic/claude-sonnet-5';

// Agents are generic — the server creates the agent for every installation,
// so no organization picker is needed here.
export function AgentNewPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
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
    <>
      <PageTitle>Agents</PageTitle>
      <SectionHeading>New agent</SectionHeading>
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
