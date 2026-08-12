import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import type { ApiRunnerCredential } from '../../shared/api-types.ts';
import { api, ApiError } from '../lib/api.ts';
import { runnerCredentialsQuery } from '../lib/queries.ts';
import { ConfirmButton } from '../components/confirm-button.tsx';
import { EmptyState, Muted, PageTitle, SectionHeading } from '../components/section.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card } from '../components/ui/card.tsx';
import { Field, Input, Select } from '../components/ui/input.tsx';
import { Pill } from '../components/ui/pill.tsx';

// Bring-your-own runner subscription (Claude/Codex), scoped to the signed-in
// user — not per-installation like integrations.tsx, since a subscription
// belongs to one human and any teammate spending it silently would be wrong.
// Factory runs this user triggers (fix/plan/generate/verify) authenticate
// with it instead of the Worker's shared secrets; see resolveRunnerAuth.

const AUTH_MODES: Record<string, { value: string; label: string }[]> = {
  claude: [
    { value: 'subscription', label: 'Claude Pro/Max subscription' },
    { value: 'gateway', label: 'API key / gateway' },
  ],
  codex: [
    { value: 'subscription', label: 'ChatGPT subscription' },
    { value: 'api_key', label: 'API key / gateway' },
  ],
};

const RUNNER_LABEL: Record<string, string> = { claude: 'Claude', codex: 'Codex' };

function onApiError(err: unknown) {
  toast.error(err instanceof ApiError ? err.message : 'request failed');
}

function CredentialCard({ cred }: { cred: ApiRunnerCredential }) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['runner-credentials'] });
  const remove = useMutation({
    mutationFn: () => api.delete(`/api/runner-credentials/${cred.runner}`),
    onSuccess: () => {
      toast.success('runner credential removed');
      refresh();
    },
    onError: onApiError,
  });

  return (
    <Card className="mt-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <Pill>{RUNNER_LABEL[cred.runner] ?? cred.runner}</Pill>
          <span className="font-medium">{cred.auth_mode}</span>
          <Pill tone="on">secret set</Pill>
          {cred.tos_acknowledged_at ? <Pill>ToS acknowledged</Pill> : null}
        </span>
        <ConfirmButton
          size="sm"
          variant="secondary"
          title="Remove this runner credential?"
          description={`Future factory runs you trigger fall back to the Worker's default credential for ${RUNNER_LABEL[cred.runner] ?? cred.runner} immediately.`}
          confirmLabel="Remove"
          onConfirm={() => remove.mutate()}
          busy={remove.isPending}
        >
          Remove
        </ConfirmButton>
      </div>
      {cred.base_url ? (
        <div className="mt-1 font-mono text-xs break-all text-mute">{cred.base_url}</div>
      ) : null}
    </Card>
  );
}

interface CredentialForm {
  runner: string;
  auth_mode: string;
  secret: string;
  base_url: string;
  tos_ack: boolean;
}

function AddForm({ taken }: { taken: string[] }) {
  const queryClient = useQueryClient();
  const firstAvailable = () =>
    (['claude', 'codex'] as const).find((r) => !taken.includes(r)) ?? 'claude';
  const blankForm = (): CredentialForm => ({
    runner: firstAvailable(),
    auth_mode: AUTH_MODES[firstAvailable()][0].value,
    secret: '',
    base_url: '',
    tos_ack: false,
  });
  const [form, setForm] = useState<CredentialForm>(blankForm);
  const [error, setError] = useState<string | null>(null);
  const gated = form.runner === 'codex' && form.auth_mode === 'subscription';
  const add = useMutation({
    mutationFn: () => api.post('/api/runner-credentials', form),
    onSuccess: () => {
      setForm(blankForm());
      setError(null);
      toast.success('runner credential saved');
      queryClient.invalidateQueries({ queryKey: ['runner-credentials'] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'request failed'),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    add.mutate();
  };
  const setRunner = (runner: string) =>
    setForm((f) => ({ ...f, runner, auth_mode: AUTH_MODES[runner][0].value, tos_ack: false }));

  return (
    <form onSubmit={submit}>
      <div className="grid gap-x-4 sm:grid-cols-2">
        <Field label="runner">
          <Select value={form.runner} onChange={(e) => setRunner(e.target.value)}>
            <option value="claude" disabled={taken.includes('claude')}>
              Claude{taken.includes('claude') ? ' (already connected)' : ''}
            </option>
            <option value="codex" disabled={taken.includes('codex')}>
              Codex{taken.includes('codex') ? ' (already connected)' : ''}
            </option>
          </Select>
        </Field>
        <Field label="auth mode">
          <Select
            value={form.auth_mode}
            onChange={(e) => setForm((f) => ({ ...f, auth_mode: e.target.value, tos_ack: false }))}
          >
            {AUTH_MODES[form.runner].map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field
        label={form.auth_mode === 'subscription' ? 'token' : 'API key'}
        hint={
          form.runner === 'claude' && form.auth_mode === 'subscription'
            ? 'from `claude setup-token`'
            : form.runner === 'codex' && form.auth_mode === 'subscription'
              ? 'contents of ~/.codex/auth.json after `codex login`'
              : 'stored encrypted, never shown again'
        }
      >
        <Input
          value={form.secret}
          onChange={(e) => setForm((f) => ({ ...f, secret: e.target.value }))}
          required
          autoComplete="off"
        />
      </Field>
      {form.auth_mode === 'gateway' || form.auth_mode === 'api_key' ? (
        <Field
          label="base URL"
          hint={form.auth_mode === 'gateway' ? 'required — https' : 'optional — a custom gateway'}
        >
          <Input
            value={form.base_url}
            onChange={(e) => setForm((f) => ({ ...f, base_url: e.target.value }))}
            required={form.auth_mode === 'gateway'}
            placeholder="https://api.example.com/v1"
          />
        </Field>
      ) : null}
      {gated ? (
        <label className="mt-4 flex items-start gap-2 text-xs text-mute">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={form.tos_ack}
            onChange={(e) => setForm((f) => ({ ...f, tos_ack: e.target.checked }))}
          />
          <span>
            Reusing my ChatGPT session headlessly here is my own responsibility to review against
            OpenAI's terms of service — turbodiff doesn't make that call for me.
          </span>
        </label>
      ) : null}
      {error ? <p className="mt-4 text-[0.85rem] text-danger">{error}</p> : null}
      <div className="mt-5">
        <Button type="submit" loading={add.isPending} disabled={gated && !form.tos_ack}>
          Save credential
        </Button>
      </div>
    </form>
  );
}

export function RunnerCredentialsPage() {
  const { data } = useSuspenseQuery(runnerCredentialsQuery);
  const taken = data.credentials.map((c) => c.runner);

  return (
    <>
      <PageTitle>my agents</PageTitle>
      <p className="mt-3 text-[0.85rem] text-mute">
        Connect your own Claude or Codex subscription so factory runs you trigger (fix, plan,
        generate, verify) spend it instead of turbodiff's shared credential.
      </p>
      <p className="mt-1.5 text-xs text-mute/70">
        Personal to your account — not shared with teammates. Secrets are encrypted and
        write-only.
      </p>
      {!data.encryption_configured ? (
        <p className="mt-3 text-[0.85rem] text-danger">
          Credential storage needs the TOKEN_ENCRYPTION_KEY secret to be configured on the Worker.
        </p>
      ) : null}

      <SectionHeading>connected</SectionHeading>
      {data.credentials.length === 0 ? (
        <EmptyState>No runner credentials yet — add one below.</EmptyState>
      ) : (
        data.credentials.map((cred) => <CredentialCard key={cred.runner} cred={cred} />)
      )}

      {taken.length < 2 ? (
        <>
          <SectionHeading>add credential</SectionHeading>
          <AddForm taken={taken} />
        </>
      ) : (
        <Muted className="mt-4 block text-xs">
          Both runners are connected. Remove one above to replace it.
        </Muted>
      )}
    </>
  );
}
