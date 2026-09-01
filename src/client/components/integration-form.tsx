import { Link } from '@tanstack/react-router';
import { ArrowLeft, Check, KeyRound } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { cn } from '../lib/utils.ts';
import { EntityFormLayout, FormSection } from './entity-form.tsx';
import { Button } from './ui/button.tsx';
import { Field, Input, Select } from './ui/input.tsx';

const AUTH_TYPES = ['none', 'bearer', 'api_key', 'client_credentials', 'oauth'] as const;
export type AuthType = (typeof AUTH_TYPES)[number];

function isAuthType(value: string): value is AuthType {
  return AUTH_TYPES.some((t) => t === value);
}

export interface IntegrationFormValues {
  installation_id: number;
  kind: string;
  name: string;
  url: string;
  auth_type: AuthType;
  token: string;
  header_name: string;
  header_value: string;
  client_id: string;
  client_secret: string;
  token_endpoint: string;
  scope: string;
  tools: string;
}

// Two-option picker as a segmented control — a native select for a binary
// choice reads heavier than it deserves.
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

const SECRET_HINT = 'stored encrypted, never shown again';

// Shared create form for a connection (MCP server or stored-credential API).
// Server-side validation is authoritative; the caller surfaces its message.
export function IntegrationForm({
  installations,
  encryptionConfigured,
  error,
  busy,
  onSubmit,
  onCancel,
}: {
  installations: { id: number; account_login: string }[];
  encryptionConfigured: boolean;
  error: string | null;
  busy: boolean;
  onSubmit: (values: IntegrationFormValues) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<IntegrationFormValues>({
    installation_id: installations[0]?.id ?? 0,
    kind: 'mcp',
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
  });
  const set = (patch: Partial<IntegrationFormValues>) => setForm((f) => ({ ...f, ...patch }));

  const needsSecret =
    form.auth_type === 'bearer' ||
    form.auth_type === 'api_key' ||
    form.auth_type === 'client_credentials';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit(form);
  };

  return (
    <EntityFormLayout
      kind="integration"
      title="New integration"
      subtitle="Connect an MCP server (its tools mount on repo runs) or a stored-credential API, once per installation."
      back={
        <Link
          to="/integrations"
          className="inline-flex items-center gap-1.5 py-1 text-xs text-mute hover:text-ink"
        >
          <ArrowLeft className="size-3.5" aria-hidden /> Integrations
        </Link>
      }
      onSubmit={submit}
    >
      <FormSection label="Connection">
        <div className="grid gap-4 sm:grid-cols-2">
          <Segmented
            label="Type"
            value={form.kind}
            options={[
              { value: 'mcp', label: 'MCP server', hint: 'mounts tools on repo runs' },
              { value: 'api', label: 'API', hint: 'stored-credential endpoint' },
            ]}
            onChange={(kind) =>
              set({
                kind,
                // OAuth sign-in only makes sense for MCP servers.
                auth_type: kind !== 'mcp' && form.auth_type === 'oauth' ? 'none' : form.auth_type,
              })
            }
          />
          {installations.length > 1 ? (
            <Field label="Installation" className="mt-0">
              <Select
                value={form.installation_id}
                onChange={(e) => set({ installation_id: Number(e.target.value) })}
              >
                {installations.map((i) => (
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
            className="mt-0"
            hint={form.kind === 'mcp' ? 'tools mount as mcp__<name>__<tool>' : 'identifier'}
          >
            <Input
              value={form.name}
              onChange={(e) => set({ name: e.target.value })}
              required
              maxLength={31}
              placeholder="executor"
              className="font-mono"
            />
          </Field>
          <Field label="Auth type" className="mt-0">
            <Select
              value={form.auth_type}
              onChange={(e) => {
                if (isAuthType(e.target.value)) set({ auth_type: e.target.value });
              }}
            >
              <option value="none">None</option>
              <option value="bearer">Bearer token</option>
              <option value="api_key">API key (custom header)</option>
              <option value="client_credentials">OAuth client credentials</option>
              {form.kind === 'mcp' ? <option value="oauth">OAuth (sign-in)</option> : null}
            </Select>
          </Field>
        </div>
        <Field label="Endpoint URL" className="mt-0" hint="https">
          <Input
            type="url"
            value={form.url}
            onChange={(e) => set({ url: e.target.value })}
            required
            placeholder="https://mcp.example.com/…"
            className="font-mono"
          />
        </Field>
      </FormSection>

      {form.auth_type !== 'none' ? (
        <FormSection label="Credentials">
          {needsSecret && !encryptionConfigured ? (
            <p className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/5 px-3 py-2 text-xs text-warn">
              <KeyRound className="mt-px size-3.5 shrink-0" aria-hidden />
              <span>
                Credential encryption isn't configured — set the{' '}
                <span className="font-mono">TOKEN_ENCRYPTION_KEY</span> secret before storing one.
              </span>
            </p>
          ) : null}

          {form.auth_type === 'bearer' ? (
            <Field label="Bearer token" className="mt-0" hint={SECRET_HINT}>
              <Input
                value={form.token}
                onChange={(e) => set({ token: e.target.value })}
                autoComplete="off"
              />
            </Field>
          ) : null}

          {form.auth_type === 'api_key' ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Header name" className="mt-0">
                <Input
                  value={form.header_name}
                  onChange={(e) => set({ header_name: e.target.value })}
                  placeholder="X-API-Key"
                  className="font-mono"
                />
              </Field>
              <Field label="Header value" className="mt-0" hint={SECRET_HINT}>
                <Input
                  value={form.header_value}
                  onChange={(e) => set({ header_value: e.target.value })}
                  autoComplete="off"
                />
              </Field>
            </div>
          ) : null}

          {form.auth_type === 'client_credentials' ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Client id" className="mt-0">
                <Input
                  value={form.client_id}
                  onChange={(e) => set({ client_id: e.target.value })}
                  className="font-mono"
                />
              </Field>
              <Field label="Client secret" className="mt-0" hint={SECRET_HINT}>
                <Input
                  value={form.client_secret}
                  onChange={(e) => set({ client_secret: e.target.value })}
                  autoComplete="off"
                />
              </Field>
              <Field label="Token endpoint" className="mt-0" hint="https">
                <Input
                  type="url"
                  value={form.token_endpoint}
                  onChange={(e) => set({ token_endpoint: e.target.value })}
                  placeholder="https://auth.example.com/token"
                  className="font-mono"
                />
              </Field>
              <Field label="Scope" className="mt-0" hint="optional">
                <Input
                  value={form.scope}
                  onChange={(e) => set({ scope: e.target.value })}
                  className="font-mono"
                />
              </Field>
            </div>
          ) : null}

          {form.auth_type === 'oauth' ? (
            <p className="text-xs leading-relaxed text-mute/80">
              turbodiff auto-discovers this server's OAuth endpoints and registers itself as a
              client — nothing to enter here. Click “Connect via OAuth” on its card after adding.
            </p>
          ) : null}
        </FormSection>
      ) : null}

      {form.kind === 'mcp' ? (
        <FormSection label="Tools">
          <Field
            label="Tool allowlist"
            className="mt-0"
            hint="optional, comma-separated; empty = all tools the server exposes"
          >
            <Input
              value={form.tools}
              onChange={(e) => set({ tools: e.target.value })}
              placeholder="search_deps, check_license"
              className="font-mono"
            />
          </Field>
        </FormSection>
      ) : null}

      {error ? <p className="text-[0.85rem] text-danger">{error}</p> : null}
      <div className="flex items-center gap-2">
        <Button type="submit" loading={busy}>
          {busy ? null : <Check className="size-4" aria-hidden />}
          Add integration
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </EntityFormLayout>
  );
}
