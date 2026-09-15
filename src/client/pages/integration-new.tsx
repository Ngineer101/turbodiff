import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { toast } from 'sonner';
import { ApiError } from '../lib/api.ts';
import { createIntegration } from '../lib/backend.ts';
import { integrationsQuery } from '../lib/queries.ts';
import { IntegrationForm, type IntegrationFormValues } from '../components/integration-form.tsx';

// Integrations are per-installation; the form's installation picker (shown
// only when there's more than one) decides where the connection lands.
export function IntegrationNewPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data } = useSuspenseQuery(integrationsQuery);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: (values: IntegrationFormValues) => createIntegration(values),
    onSuccess: () => {
      toast.success('Integration added');
      void queryClient.invalidateQueries({ queryKey: ['integrations'] });
      void navigate({ to: '/integrations' });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Request failed'),
  });

  return (
    <IntegrationForm
      organizations={data.organizations}
      encryptionConfigured={data.encryption_configured}
      error={error}
      busy={create.isPending}
      onSubmit={(values) => create.mutate(values)}
      onCancel={() => navigate({ to: '/integrations' })}
    />
  );
}
