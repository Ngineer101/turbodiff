import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { KeyRound, Server, ShieldAlert } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import type {
  ApiConnectionTest,
  ApiIntegration,
  ApiIntegrationAgent,
} from '../../shared/api-types.ts';
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
  toast.error(err instanceof ApiError ? err.message : 'Request failed');
}

// The uppercase mono micro-label that names a block inside a card.
function Placard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'font-mono text-[10px] font-medium tracking-[0.14em] text-mute uppercase',
        className,
      )}
    >
      {children}
    </span>
  );
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
      <DialogContent className="max-h-[85dvh] max-w-lg overflow-y-auto">
        <DialogTitle className="pr-8 text-base font-medium">
          Test <Pill>{name}</Pill>
        </DialogTitle>
        <p className="mt-3 flex flex-wrap items-center gap-2 text-[0.85rem]">
          {result.ok ? <Pill tone="on">OK</Pill> : <Pill tone="red">Failed</Pill>}
          <span className="min-w-0 break-words">{result.detail}</span>
        </p>
        {result.tools.length > 0 ? (
          <div className="-mx-1 mt-1 overflow-x-auto px-1">
            <Table>
              <thead>
                <tr>
                  <Th>Tool</Th>
                  <Th>Mounts as</Th>
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
          </div>
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

function IntegrationCard({
  conn,
  agents,
}: {
  conn: ApiIntegration;
  agents: ApiIntegrationAgent[];
}) {
  const queryClient = useQueryClient();
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['integrations'] });
  };
  const [test, setTest] = useState<ApiConnectionTest | null>(null);

  const runTest = useMutation({
    mutationFn: () => api.post<ApiConnectionTest>(`/api/integrations/${conn.id}/test`),
    onSuccess: setTest,
    onError: onApiError,
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/api/integrations/${conn.id}`),
    onSuccess: () => {
      toast.success('Integration removed');
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
  const attachedCount = agents.filter((a) => conn.agent_ids.includes(a.id)).length;

  return (
    <Card className="p-3.5 sm:p-4">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2.5">
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <Pill>{conn.kind === 'mcp' ? 'MCP' : 'API'}</Pill>
          <span className="font-medium break-all">{conn.name}</span>
          <AuthPill conn={conn} />
        </span>
        <span className="flex flex-wrap gap-1.5 max-sm:w-full">
          {needsOAuthConnect ? (
            <Button
              size="sm"
              variant="secondary"
              className="max-sm:flex-1"
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
            className="max-sm:flex-1"
            onClick={() => runTest.mutate()}
            loading={runTest.isPending}
          >
            Test
          </Button>
          <ConfirmButton
            size="sm"
            variant="secondary"
            className="max-sm:flex-1"
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

      <div className="mt-3 flex flex-wrap items-baseline gap-x-2.5 gap-y-1 rounded-lg border border-line/70 bg-bg/40 px-2.5 py-2">
        <Placard>URL</Placard>
        <span className="min-w-0 font-mono text-xs break-all text-ink-dim">{conn.url}</span>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <Placard>Tools</Placard>
        {conn.tools && conn.tools.length > 0 ? (
          conn.tools.map((t) => (
            <Pill key={t} className="max-w-full truncate">
              {t}
            </Pill>
          ))
        ) : (
          <Muted className="text-xs">all tools exposed by the server</Muted>
        )}
      </div>

      {conn.auth_type === 'api_key' && conn.kind === 'mcp' ? (
        <p className="mt-2.5 text-xs text-mute/80">
          Mounted into review agents only when the header name is exactly "Authorization" —
          otherwise this credential is verified by Test but not used at review time (a @flue/runtime
          limitation).
        </p>
      ) : null}

      {conn.kind === 'mcp' ? (
        <div className="mt-3 border-t border-line/70 pt-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Placard>Attached agents</Placard>
            <span className="font-mono text-[10px] text-mute/70 tabular-nums">
              {attachedCount}/{agents.length}
            </span>
          </div>
          {agents.length === 0 ? (
            <Muted className="mt-2 block text-xs">
              This installation has no agents yet — create one first.
            </Muted>
          ) : (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {agents.map((a) => {
                const attached = conn.agent_ids.includes(a.id);
                return (
                  <button
                    key={a.id}
                    type="button"
                    aria-pressed={attached}
                    title={`${attached ? 'Detach from' : 'Attach to'} ${a.name}`}
                    onClick={() => toggleAgent.mutate({ agentId: a.id, attached: !attached })}
                    className={cn(
                      'cursor-pointer rounded-full border px-2.5 py-1 font-mono text-xs whitespace-nowrap transition-colors max-sm:px-3.5 max-sm:py-2',
                      attached
                        ? 'border-accent/40 bg-accent/10 text-accent-bright'
                        : 'border-line-2/70 text-mute hover:border-line-2 hover:bg-raised hover:text-ink-dim',
                    )}
                  >
                    {a.slug}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        <p className="mt-3 border-t border-line/70 pt-3 text-xs text-mute">
          Stored API credential — not mounted to agents (MCP integrations are).
        </p>
      )}
      {test ? <TestDialog name={conn.name} result={test} onClose={() => setTest(null)} /> : null}
    </Card>
  );
}

// Two-option picker rendered as a segmented control — a native select for a
// binary choice reads as heavier than the choice deserves.
function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; hint: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div>
      <span className="block text-xs text-mute">{label}</span>
      <div
        role="group"
        aria-label={label}
        className="mt-1 grid grid-cols-2 gap-1 rounded-lg border border-line-2/70 bg-surface p-1 sm:rounded-md"
      >
        {options.map((o) => {
          const selected = o.value === value;
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={selected}
              aria-label={`${o.label} — ${o.hint}`}
              onClick={() => onChange(o.value)}
              className={cn(
                'cursor-pointer rounded-md px-2.5 py-1.5 text-left transition-colors max-sm:min-h-11',
                selected
                  ? 'bg-accent/12 text-ink inset-ring inset-ring-accent/40'
                  : 'text-mute hover:bg-raised hover:text-ink-dim',
              )}
            >
              <span className="block text-[0.8rem] font-medium">{o.label}</span>
              <span className="block text-[0.7rem] text-mute/80">{o.hint}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// The credential fields for the selected auth type, grouped into their own
// panel so the form's shape doesn't shift with every auth change.
function CredentialsPanel({ children, note }: { children?: ReactNode; note?: ReactNode }) {
  return (
    <div className="rounded-xl border border-line/80 bg-surface/50 p-3.5">
      <Placard>Credentials</Placard>
      {children}
      {note ? <p className="mt-3 text-xs text-mute/80">{note}</p> : null}
    </div>
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
      toast.success('Integration added');
      void queryClient.invalidateQueries({ queryKey: ['integrations'] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Request failed'),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    add.mutate();
  };
  const secretHint = 'stored encrypted, never shown again';
  const needsSecret =
    form.auth_type === 'bearer' ||
    form.auth_type === 'api_key' ||
    form.auth_type === 'client_credentials';

  return (
    <Card className="p-3.5 sm:p-5">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Segmented
            label="Type"
            value={form.kind}
            options={[
              { value: 'mcp', label: 'MCP server', hint: 'mounts tools on agents' },
              { value: 'api', label: 'API', hint: 'stored-credential endpoint' },
            ]}
            onChange={(kind) =>
              setForm((f) => ({
                ...f,
                kind,
                // The OAuth auth type only makes sense for MCP-kind servers.
                auth_type: kind !== 'mcp' && f.auth_type === 'oauth' ? 'none' : f.auth_type,
              }))
            }
          />
          {data.installations.length > 1 ? (
            <Field label="Installation" className="mt-0">
              <Select
                value={form.installation_id}
                onChange={(e) =>
                  setForm((f) => ({ ...f, installation_id: Number(e.target.value) }))
                }
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

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Name"
            hint={form.kind === 'mcp' ? 'tools mount as mcp__<name>__<tool>' : 'identifier'}
            className="mt-0"
          >
            <Input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              required
              maxLength={31}
              placeholder="executor"
              className="font-mono"
            />
          </Field>
          <Field label="Auth type" className="mt-0">
            <Select
              value={form.auth_type}
              onChange={(e) => setForm((f) => ({ ...f, auth_type: e.target.value as AuthType }))}
            >
              <option value="none">None</option>
              <option value="bearer">Bearer token</option>
              <option value="api_key">API key (custom header)</option>
              <option value="client_credentials">OAuth client credentials</option>
              {form.kind === 'mcp' ? <option value="oauth">OAuth (sign-in)</option> : null}
            </Select>
          </Field>
        </div>

        <Field label="Endpoint URL" hint="https" className="mt-0">
          <Input
            type="url"
            value={form.url}
            onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
            required
            placeholder="https://mcp.example.com/…"
            className="font-mono"
          />
        </Field>

        {needsSecret && !data.encryption_configured ? (
          <p className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/5 px-3 py-2 text-xs text-warn">
            <KeyRound className="mt-px size-3.5 shrink-0" aria-hidden />
            <span>
              Credential encryption isn't configured — set the{' '}
              <span className="font-mono">TOKEN_ENCRYPTION_KEY</span> secret before storing one.
            </span>
          </p>
        ) : null}

        {form.auth_type === 'bearer' ? (
          <CredentialsPanel>
            <Field label="bearer token" hint={secretHint}>
              <Input
                value={form.token}
                onChange={(e) => setForm((f) => ({ ...f, token: e.target.value }))}
                autoComplete="off"
              />
            </Field>
          </CredentialsPanel>
        ) : null}

        {form.auth_type === 'api_key' ? (
          <CredentialsPanel>
            <div className="grid gap-x-4 sm:grid-cols-2">
              <Field label="header name">
                <Input
                  value={form.header_name}
                  onChange={(e) => setForm((f) => ({ ...f, header_name: e.target.value }))}
                  placeholder="X-API-Key"
                  className="font-mono"
                />
              </Field>
              <Field label="header value" hint={secretHint}>
                <Input
                  value={form.header_value}
                  onChange={(e) => setForm((f) => ({ ...f, header_value: e.target.value }))}
                  autoComplete="off"
                />
              </Field>
            </div>
          </CredentialsPanel>
        ) : null}

        {form.auth_type === 'client_credentials' ? (
          <CredentialsPanel>
            <div className="grid gap-x-4 sm:grid-cols-2">
              <Field label="client id">
                <Input
                  value={form.client_id}
                  onChange={(e) => setForm((f) => ({ ...f, client_id: e.target.value }))}
                  className="font-mono"
                />
              </Field>
              <Field label="client secret" hint={secretHint}>
                <Input
                  value={form.client_secret}
                  onChange={(e) => setForm((f) => ({ ...f, client_secret: e.target.value }))}
                  autoComplete="off"
                />
              </Field>
              <Field label="token endpoint" hint="https">
                <Input
                  type="url"
                  value={form.token_endpoint}
                  onChange={(e) => setForm((f) => ({ ...f, token_endpoint: e.target.value }))}
                  placeholder="https://auth.example.com/token"
                  className="font-mono"
                />
              </Field>
              <Field label="scope" hint="optional">
                <Input
                  value={form.scope}
                  onChange={(e) => setForm((f) => ({ ...f, scope: e.target.value }))}
                  className="font-mono"
                />
              </Field>
            </div>
          </CredentialsPanel>
        ) : null}

        {form.auth_type === 'oauth' ? (
          <CredentialsPanel
            note={
              <>
                turbodiff auto-discovers this server's OAuth endpoints and registers itself as a
                client — nothing to enter here. Click "Connect via OAuth" on the card above after
                adding.
              </>
            }
          />
        ) : null}

        {form.kind === 'mcp' ? (
          <Field
            label="Tool allowlist"
            hint="optional, comma-separated; empty = all"
            className="mt-0"
          >
            <Input
              value={form.tools}
              onChange={(e) => setForm((f) => ({ ...f, tools: e.target.value }))}
              placeholder="search_deps, check_license"
              className="font-mono"
            />
          </Field>
        ) : null}

        {error ? <p className="text-[0.85rem] text-danger">{error}</p> : null}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line/70 pt-4">
          <Muted className="text-xs">
            {form.kind === 'mcp'
              ? 'Attach it to agents on its card once added.'
              : 'Stored for use by the API tools — not mounted to agents.'}
          </Muted>
          <Button type="submit" loading={add.isPending} className="max-sm:w-full">
            Add integration
          </Button>
        </div>
      </form>
    </Card>
  );
}

// The two standing caveats, kept compact so they read as guardrails rather
// than as three paragraphs of body copy.
function Notes() {
  return (
    <div className="mt-4 grid gap-2 sm:grid-cols-2">
      <p className="flex items-start gap-2.5 rounded-xl border border-line/70 bg-surface/50 px-3.5 py-3 text-xs leading-relaxed text-mute">
        <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-mute/70" aria-hidden />
        <span>
          Tokens are encrypted and write-only. Connected servers see the PR context agents send them
          and their output is untrusted — connect only servers you control or trust.
        </span>
      </p>
      <p className="flex items-start gap-2.5 rounded-xl border border-line/70 bg-surface/50 px-3.5 py-3 text-xs leading-relaxed text-mute">
        <Server className="mt-0.5 size-3.5 shrink-0 text-mute/70" aria-hidden />
        <span>
          Remote HTTP servers only (streamable-HTTP or SSE). stdio servers aren't supported — review
          agents run in a Durable Object with no subprocess or filesystem access.
        </span>
      </p>
    </div>
  );
}

export function IntegrationsPage() {
  const { data } = useSuspenseQuery(integrationsQuery);
  useOAuthCallbackToast();

  // Connections and agents are both per-installation, and a connection may
  // only attach to its own installation's agent rows — so group the list and
  // hand each card just that installation's agents.
  const groups = data.installations
    .map((inst) => ({
      installation: inst,
      connections: data.connections.filter((c) => c.installation_id === inst.id),
      agents: data.agents.filter((a) => a.installation_id === inst.id),
    }))
    .filter((g) => g.connections.length > 0);
  const multiInstall = data.installations.length > 1;

  return (
    <>
      <PageTitle
        aside={
          data.connections.length > 0 ? <Pill>{data.connections.length} connected</Pill> : null
        }
      >
        MCP &amp; integrations
      </PageTitle>
      <p className="mt-3 max-w-2xl text-[0.85rem] text-mute">
        Connect MCP servers and APIs once, then attach MCP integrations to the agents that should
        use their tools.
      </p>
      <Notes />

      <SectionHeading>Connected</SectionHeading>
      {data.connections.length === 0 ? (
        <EmptyState>No integrations yet — add one below.</EmptyState>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map(({ installation, connections, agents }) => (
            <section key={installation.id} className="flex flex-col gap-2">
              {multiInstall ? (
                <Placard className="px-0.5">{installation.account_login}</Placard>
              ) : null}
              {connections.map((conn) => (
                <IntegrationCard key={conn.id} conn={conn} agents={agents} />
              ))}
            </section>
          ))}
        </div>
      )}

      <SectionHeading>Add integration</SectionHeading>
      <AddForm />
    </>
  );
}
