import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import type { ApiConnectionTest, ApiIntegration } from '../../shared/api-types.ts';
import { api, ApiError } from '../lib/api.ts';
import { integrationsQuery } from '../lib/queries.ts';
import { cn } from '../lib/utils.ts';
import { ConfirmButton } from '../components/confirm-button.tsx';
import { EmptyState, Muted, PageTitle, SectionHeading } from '../components/section.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card } from '../components/ui/card.tsx';
import { Dialog, DialogContent, DialogTitle } from '../components/ui/dialog.tsx';
import { Field, Input, Select } from '../components/ui/input.tsx';
import { Pill } from '../components/ui/pill.tsx';
import { Table, Td, Th } from '../components/ui/table.tsx';

// Central integrations registry: MCP servers (mountable as agent tools) and
// bearer-auth APIs, added once per installation. MCP integrations attach to
// review agents with the toggles on each card.

const AUTH_TYPES = ['none', 'bearer', 'api_key', 'client_credentials', 'oauth'] as const;
type AuthType = (typeof AUTH_TYPES)[number];

function onApiError(err: unknown) {
  toast.error(err instanceof ApiError ? err.message : 'request failed');
}

// Reads the one-time ?oauth=connected|error query params the
// /oauth/callback redirect lands with, toasts once, then scrubs the URL so a
// refresh doesn't re-toast.
function useOAuthCallbackToast() {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauth = params.get('oauth');
    if (!oauth) return;
    if (oauth === 'connected') {
      const name = params.get('name');
      toast.success(name ? `connected "${name}" via OAuth` : 'connected via OAuth');
    } else if (oauth === 'error') {
      const reason = params.get('reason');
      toast.error(reason ? `OAuth connect failed: ${reason}` : 'OAuth connect failed');
    }
    window.history.replaceState(null, '', window.location.pathname);
  }, []);
}

function TestDialog({
  name,
  result,
  onClose,
}: {
  name: string;
  result: ApiConnectionTest;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogTitle className="text-base font-medium">
          test <Pill>{name}</Pill>
        </DialogTitle>
        <p className="mt-3 text-[0.85rem]">
          {result.ok ? <Pill tone="on">ok</Pill> : <Pill tone="red">failed</Pill>} {result.detail}
        </p>
        {result.tools.length > 0 ? (
          <Table>
            <thead>
              <tr>
                <Th>tool</Th>
                <Th>mounts as</Th>
              </tr>
            </thead>
            <tbody>
              {result.tools.map((t) => (
                <tr key={t}>
                  <Td className="font-mono">{t}</Td>
                  <Td>
                    <Muted className="font-mono">
                      mcp__{name}__{t}
                    </Muted>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function AuthPill({ conn }: { conn: ApiIntegration }) {
  if (conn.auth_type === 'none') return <Pill>no auth</Pill>;
  if (conn.auth_type !== 'oauth') {
    return <Pill tone="on">{conn.auth_type} configured</Pill>;
  }
  switch (conn.oauth_status) {
    case 'connected':
      return <Pill tone="on">oauth connected</Pill>;
    case 'expired':
      return <Pill tone="warn">oauth expired</Pill>;
    case 'needs_reauth':
      return <Pill tone="red">oauth needs re-auth</Pill>;
    default:
      return <Pill>oauth not connected</Pill>;
  }
}

function IntegrationCard({ conn }: { conn: ApiIntegration }) {
  const queryClient = useQueryClient();
  const { data } = useSuspenseQuery(integrationsQuery);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['integrations'] });
  const [test, setTest] = useState<ApiConnectionTest | null>(null);
  const agents = data.agents.filter((a) =>
    data.installations.some((i) => i.id === conn.installation_id),
  );

  const runTest = useMutation({
    mutationFn: () => api.post<ApiConnectionTest>(`/api/integrations/${conn.id}/test`),
    onSuccess: setTest,
    onError: onApiError,
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/api/integrations/${conn.id}`),
    onSuccess: () => {
      toast.success('integration removed');
      refresh();
    },
    onError: onApiError,
  });
  const toggleAgent = useMutation({
    mutationFn: ({ agentId, attached }: { agentId: number; attached: boolean }) =>
      api.put(`/api/integrations/${conn.id}/agents/${agentId}`, { attached }),
    onSuccess: refresh,
    onError: onApiError,
  });

  const needsOAuthConnect =
    conn.kind === 'mcp' && conn.auth_type === 'oauth' && conn.oauth_status !== 'connected';

  return (
    <Card className="mt-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <Pill>{conn.kind}</Pill>
          <span className="font-medium">{conn.name}</span>
          <AuthPill conn={conn} />
        </span>
        <span className="flex gap-1.5">
          {needsOAuthConnect ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                window.location.href = `/api/integrations/${conn.id}/oauth/start`;
              }}
            >
              Connect via OAuth
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => runTest.mutate()}
            loading={runTest.isPending}
          >
            Test
          </Button>
          <ConfirmButton
            size="sm"
            variant="secondary"
            title="Remove this integration?"
            description={`Agents lose access to "${conn.name}" on their next run. The stored credential is deleted.`}
            confirmLabel="Remove"
            onConfirm={() => remove.mutate()}
            busy={remove.isPending}
          >
            Remove
          </ConfirmButton>
        </span>
      </div>
      <div className="mt-1 font-mono text-xs break-all text-mute">{conn.url}</div>
      {conn.tools ? (
        <div className="mt-1 text-xs text-mute">
          tools: <span className="font-mono">{conn.tools.join(', ')}</span>
        </div>
      ) : null}
      {conn.auth_type === 'api_key' && conn.kind === 'mcp' ? (
        <Muted className="mt-1 block text-xs">
          Mounted into review agents only when the header name is exactly "Authorization" —
          otherwise this credential is verified by Test but not used at review time (a @flue/runtime
          limitation).
        </Muted>
      ) : null}
      {conn.kind === 'mcp' ? (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <Muted className="mr-1 text-xs">agents:</Muted>
          {agents.map((a) => {
            const attached = conn.agent_ids.includes(a.id);
            return (
              <button
                key={a.id}
                type="button"
                aria-pressed={attached}
                title={`${attached ? 'detach from' : 'attach to'} ${a.name}`}
                onClick={() => toggleAgent.mutate({ agentId: a.id, attached: !attached })}
                className={cn(
                  'cursor-pointer rounded-full border px-2.5 py-px text-xs whitespace-nowrap transition-colors',
                  attached
                    ? 'border-accent/40 text-accent-bright'
                    : 'border-line-2 text-mute hover:bg-raised',
                )}
              >
                {a.slug}
              </button>
            );
          })}
        </div>
      ) : (
        <Muted className="mt-2 block text-xs">
          stored API credential — not mounted to agents (MCP integrations are)
        </Muted>
      )}
      {test ? <TestDialog name={conn.name} result={test} onClose={() => setTest(null)} /> : null}
    </Card>
  );
}

function AddForm() {
  const queryClient = useQueryClient();
  const { data } = useSuspenseQuery(integrationsQuery);
  const [form, setForm] = useState({
    installation_id: data.installations[0]?.id ?? 0,
    kind: 'mcp',
    name: '',
    url: '',
    auth_type: 'none' as AuthType,
    token: '',
    header_name: '',
    header_value: '',
    client_id: '',
    client_secret: '',
    token_endpoint: '',
    scope: '',
    tools: '',
  });
  const [error, setError] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: () => api.post('/api/integrations', form),
    onSuccess: () => {
      setForm((f) => ({
        ...f,
        name: '',
        url: '',
        auth_type: 'none',
        token: '',
        header_name: '',
        header_value: '',
        client_id: '',
        client_secret: '',
        token_endpoint: '',
        scope: '',
        tools: '',
      }));
      setError(null);
      toast.success('integration added');
      queryClient.invalidateQueries({ queryKey: ['integrations'] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'request failed'),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    add.mutate();
  };
  return (
    <form onSubmit={submit}>
      <div className="grid gap-x-4 sm:grid-cols-2">
        <Field label="type">
          <Select
            value={form.kind}
            onChange={(e) => {
              const kind = e.target.value;
              setForm((f) => ({
                ...f,
                kind,
                // The OAuth auth type only makes sense for MCP-kind servers.
                auth_type: kind !== 'mcp' && f.auth_type === 'oauth' ? 'none' : f.auth_type,
              }));
            }}
          >
            <option value="mcp">MCP server (agent tools)</option>
            <option value="api">API (stored-credential endpoint)</option>
          </Select>
        </Field>
        {data.installations.length > 1 ? (
          <Field label="installation">
            <Select
              value={form.installation_id}
              onChange={(e) => setForm((f) => ({ ...f, installation_id: Number(e.target.value) }))}
            >
              {data.installations.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.account_login}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
      </div>
      <Field
        label="name"
        hint={form.kind === 'mcp' ? 'tools mount as mcp__<name>__<tool>' : 'identifier'}
      >
        <Input
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          required
          maxLength={31}
          placeholder="executor"
        />
      </Field>
      <Field label="endpoint URL" hint="https">
        <Input
          value={form.url}
          onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
          required
          placeholder="https://mcp.example.com/…"
        />
      </Field>
      <Field label="auth type">
        <Select
          value={form.auth_type}
          onChange={(e) => setForm((f) => ({ ...f, auth_type: e.target.value as AuthType }))}
        >
          <option value="none">none</option>
          <option value="bearer">bearer token</option>
          <option value="api_key">API key (custom header)</option>
          <option value="client_credentials">OAuth client credentials</option>
          {form.kind === 'mcp' ? <option value="oauth">OAuth (sign-in)</option> : null}
        </Select>
      </Field>
      {form.auth_type === 'bearer' ? (
        <Field label="bearer token" hint="stored encrypted, never shown again">
          <Input
            value={form.token}
            onChange={(e) => setForm((f) => ({ ...f, token: e.target.value }))}
            autoComplete="off"
          />
        </Field>
      ) : null}
      {form.auth_type === 'api_key' ? (
        <>
          <Field label="header name">
            <Input
              value={form.header_name}
              onChange={(e) => setForm((f) => ({ ...f, header_name: e.target.value }))}
              placeholder="X-API-Key"
            />
          </Field>
          <Field label="header value" hint="stored encrypted, never shown again">
            <Input
              value={form.header_value}
              onChange={(e) => setForm((f) => ({ ...f, header_value: e.target.value }))}
              autoComplete="off"
            />
          </Field>
        </>
      ) : null}
      {form.auth_type === 'client_credentials' ? (
        <>
          <Field label="client id">
            <Input
              value={form.client_id}
              onChange={(e) => setForm((f) => ({ ...f, client_id: e.target.value }))}
            />
          </Field>
          <Field label="client secret" hint="stored encrypted, never shown again">
            <Input
              value={form.client_secret}
              onChange={(e) => setForm((f) => ({ ...f, client_secret: e.target.value }))}
              autoComplete="off"
            />
          </Field>
          <Field label="token endpoint" hint="https">
            <Input
              value={form.token_endpoint}
              onChange={(e) => setForm((f) => ({ ...f, token_endpoint: e.target.value }))}
              placeholder="https://auth.example.com/token"
            />
          </Field>
          <Field label="scope" hint="optional">
            <Input
              value={form.scope}
              onChange={(e) => setForm((f) => ({ ...f, scope: e.target.value }))}
            />
          </Field>
        </>
      ) : null}
      {form.auth_type === 'oauth' ? (
        <p className="mt-4 text-xs text-mute">
          turbodiff auto-discovers this server's OAuth endpoints and registers itself as a client —
          click "Connect via OAuth" on the card below after adding.
        </p>
      ) : null}
      {form.kind === 'mcp' ? (
        <Field label="tool allowlist" hint="optional, comma-separated; empty = all">
          <Input
            value={form.tools}
            onChange={(e) => setForm((f) => ({ ...f, tools: e.target.value }))}
            placeholder="search_deps, check_license"
          />
        </Field>
      ) : null}
      {error ? <p className="mt-4 text-[0.85rem] text-danger">{error}</p> : null}
      <div className="mt-5">
        <Button type="submit" loading={add.isPending}>
          Add integration
        </Button>
      </div>
    </form>
  );
}

export function IntegrationsPage() {
  const { data } = useSuspenseQuery(integrationsQuery);
  useOAuthCallbackToast();

  return (
    <>
      <PageTitle>mcp &amp; integrations</PageTitle>
      <p className="mt-3 text-[0.85rem] text-mute">
        Connect MCP servers and APIs once, then attach MCP integrations to the agents that should
        use their tools.
      </p>
      <p className="mt-1.5 text-xs text-mute/70">
        Tokens are encrypted and write-only. Connected servers see the PR context agents send them
        and their output is untrusted — connect only servers you control or trust.
      </p>
      <p className="mt-1.5 text-xs text-mute/70">
        MCP connections are remote HTTP servers (streamable-HTTP or SSE) only — stdio-based servers
        aren't supported, since review agents run in a Cloudflare Durable Object with no subprocess
        or filesystem access.
      </p>

      <SectionHeading>connected</SectionHeading>
      {data.connections.length === 0 ? (
        <EmptyState>No integrations yet — add one below.</EmptyState>
      ) : (
        data.connections.map((conn) => <IntegrationCard key={conn.id} conn={conn} />)
      )}

      <SectionHeading>add integration</SectionHeading>
      <AddForm />
    </>
  );
}
