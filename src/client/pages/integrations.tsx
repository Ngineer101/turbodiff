import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { FolderGit2, Globe, Plus, PlugZap, Server, ShieldAlert, Trash2, Wrench } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import type {
  ApiConnectionTest,
  ApiIntegration,
  ApiIntegrationRepo,
  ApiIntegrations,
} from '../../shared/api-types.ts';
import { api, ApiError } from '../lib/api.ts';
import { applyOptimistic } from '../lib/optimistic.ts';
import { integrationsQuery } from '../lib/queries.ts';
import { cn } from '../lib/utils.ts';
import { ConfirmButton } from '../components/confirm-button.tsx';
import { EmptyState, Muted, PageTitle, SectionHeading } from '../components/section.tsx';
import { Button, buttonVariants } from '../components/ui/button.tsx';
import { Card } from '../components/ui/card.tsx';
import { Dialog, DialogContent, DialogTitle } from '../components/ui/dialog.tsx';
import { EntityIcon } from '../components/ui/entity-icon.tsx';
import { Pill } from '../components/ui/pill.tsx';
import { Switch } from '../components/ui/switch.tsx';
import { Table, Td, Th } from '../components/ui/table.tsx';
import { Tooltip } from '../components/ui/tooltip.tsx';

// Central integrations registry: MCP servers (mountable as run tools) and
// bearer-auth APIs, added once per installation. MCP integrations attach to
// factory-enabled repos with the toggles on each card, with per-context
// switches for reviews and automations.

function onApiError<T>(err: T) {
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

interface RepoLinkUpdate {
  repoId: number;
  attached: boolean;
  reviews?: boolean;
  automations?: boolean;
}

function IntegrationCard({ conn, repos }: { conn: ApiIntegration; repos: ApiIntegrationRepo[] }) {
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
  const toggleRepo = useMutation({
    mutationFn: ({ repoId, attached, reviews, automations }: RepoLinkUpdate) =>
      api.put(`/api/integrations/${conn.id}/repos/${repoId}`, { attached, reviews, automations }),
    // Chips flip on click; the refetch below reconciles.
    onMutate: ({ repoId, attached, reviews, automations }) =>
      applyOptimistic<ApiIntegrations>(queryClient, ['integrations'], (prev) => ({
        ...prev,
        connections: prev.connections.map((c) =>
          c.id === conn.id
            ? {
                ...c,
                repo_links: attached
                  ? [
                      ...c.repo_links.filter((l) => l.repository_id !== repoId),
                      // Same defaults the PUT handler applies when the
                      // fields are omitted.
                      {
                        repository_id: repoId,
                        reviews: reviews ?? true,
                        automations: automations ?? true,
                      },
                    ]
                  : c.repo_links.filter((l) => l.repository_id !== repoId),
              }
            : c,
        ),
      })),
    onSettled: refresh,
    onError: (err, _v, ctx) => {
      ctx?.rollback();
      onApiError(err);
    },
  });

  const needsOAuthConnect =
    conn.kind === 'mcp' && conn.auth_type === 'oauth' && conn.oauth_status !== 'connected';
  const attachedCount = repos.filter((r) =>
    conn.repo_links.some((l) => l.repository_id === r.id),
  ).length;

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <EntityIcon kind="integration" slug={conn.kind} />
          {/* min-h-10 = the tile's height; justify-between pins the name row to
              the tile's top and the meta row to its bottom. */}
          <div className="flex min-h-10 min-w-0 flex-col justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium break-all">{conn.name}</span>
              <Pill>{conn.kind === 'mcp' ? 'MCP' : 'API'}</Pill>
              <AuthPill conn={conn} />
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 font-mono text-[11px] leading-none text-mute">
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <Globe className="size-3 shrink-0" aria-hidden />
                <span className="truncate">{conn.url}</span>
              </span>
              {conn.kind === 'mcp' ? (
                <span
                  className="inline-flex shrink-0 items-center gap-1.5"
                  title={
                    conn.tools && conn.tools.length > 0
                      ? conn.tools.join(', ')
                      : 'all tools the server exposes'
                  }
                >
                  <Wrench className="size-3 shrink-0" aria-hidden />
                  {conn.tools && conn.tools.length > 0
                    ? `${conn.tools.length} tool${conn.tools.length === 1 ? '' : 's'}`
                    : 'all tools'}
                </span>
              ) : null}
              {conn.kind === 'mcp' ? (
                <span className="inline-flex shrink-0 items-center gap-1.5">
                  <FolderGit2 className="size-3 shrink-0" aria-hidden />
                  {attachedCount}/{repos.length} repos
                </span>
              ) : null}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {needsOAuthConnect ? (
            <Button
              size="sm"
              onClick={() => {
                window.location.href = `/api/integrations/${conn.id}/oauth/start`;
              }}
            >
              Connect via OAuth
            </Button>
          ) : null}
          <Tooltip label="Test connection">
            <Button
              size="icon"
              variant="secondary"
              onClick={() => runTest.mutate()}
              loading={runTest.isPending}
              aria-label="Test connection"
            >
              <PlugZap className="size-3.5" aria-hidden />
            </Button>
          </Tooltip>
          <Tooltip label="Remove integration">
            <ConfirmButton
              size="icon"
              variant="danger"
              title="Remove this integration?"
              description={`Attached repos lose access to "${conn.name}" on their next run. The stored credential is deleted.`}
              confirmLabel="Remove"
              onConfirm={() => remove.mutate()}
              busy={remove.isPending}
              aria-label="Remove integration"
            >
              <Trash2 className="size-3.5" aria-hidden />
            </ConfirmButton>
          </Tooltip>
        </div>
      </div>

      {conn.auth_type === 'api_key' && conn.kind === 'mcp' ? (
        <p className="mt-3 text-xs text-mute/80">
          Mounted into reviews only when the header name is exactly "Authorization" — otherwise this
          credential is verified by Test but not used at review time (a @flue/runtime limitation).
        </p>
      ) : null}

      {conn.kind === 'mcp' ? (
        repos.length === 0 ? (
          <Muted className="mt-3 block border-t border-line/70 pt-3 text-xs">
            This installation has no factory-enabled repos yet — enable one in settings first.
          </Muted>
        ) : (
          <div className="mt-3.5 overflow-hidden rounded-lg border border-line">
            <div className="grid grid-cols-[1fr_5.5rem_6.5rem] gap-2 bg-surface-2 px-3 py-2">
              <Placard>Repository</Placard>
              <Placard className="text-center">Reviews</Placard>
              <Placard className="text-center">Automations</Placard>
            </div>
            {repos.map((r) => {
              const repoLabel = `${r.owner}/${r.name}`;
              const link = conn.repo_links.find((l) => l.repository_id === r.id);
              const attached = link !== undefined;
              return (
                <div
                  key={r.id}
                  className="grid grid-cols-[1fr_5.5rem_6.5rem] items-center gap-2 border-t border-line px-3 py-2"
                >
                  <label className="flex min-w-0 cursor-pointer items-center gap-2 text-xs">
                    <Switch
                      checked={attached}
                      onCheckedChange={(v) => toggleRepo.mutate({ repoId: r.id, attached: v })}
                      aria-label={`Attach ${repoLabel}`}
                    />
                    <FolderGit2 className="size-3.5 shrink-0 text-mute" aria-hidden />
                    <span className={cn('truncate', attached ? 'text-ink-dim' : 'text-mute')}>
                      <span className="text-mute">{r.owner}/</span>
                      {r.name}
                    </span>
                  </label>
                  <div className="flex justify-center">
                    <Switch
                      checked={attached && !!link?.reviews}
                      disabled={!attached}
                      onCheckedChange={(v) =>
                        toggleRepo.mutate({
                          repoId: r.id,
                          attached: true,
                          reviews: v,
                          automations: link?.automations,
                        })
                      }
                      aria-label={`Reviews for ${repoLabel}`}
                    />
                  </div>
                  <div className="flex justify-center">
                    <Switch
                      checked={attached && !!link?.automations}
                      disabled={!attached}
                      onCheckedChange={(v) =>
                        toggleRepo.mutate({
                          repoId: r.id,
                          attached: true,
                          reviews: link?.reviews,
                          automations: v,
                        })
                      }
                      aria-label={`Automations for ${repoLabel}`}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )
      ) : (
        <p className="mt-3 border-t border-line/70 pt-3 text-xs text-mute">
          Stored API credential — not mounted into runs (MCP integrations are).
        </p>
      )}
      {test ? <TestDialog name={conn.name} result={test} onClose={() => setTest(null)} /> : null}
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

  // Connections and repos are both per-installation, and a connection may
  // only attach to its own installation's repos — so group the list and hand
  // each card just that installation's factory-enabled repos.
  const groups = data.installations
    .map((inst) => ({
      installation: inst,
      connections: data.connections.filter((c) => c.installation_id === inst.id),
      repos: data.repos.filter((r) => r.installation_id === inst.id),
    }))
    .filter((g) => g.connections.length > 0);
  const multiInstall = data.installations.length > 1;

  return (
    <>
      <PageTitle
        aside={
          <Link
            to="/integrations/new"
            className={buttonVariants({ variant: 'default', size: 'default' })}
          >
            <Plus className="size-4" aria-hidden /> New integration
          </Link>
        }
      >
        MCP &amp; integrations
      </PageTitle>
      <p className="mt-3 max-w-2xl text-[0.85rem] text-mute">
        Connect MCP servers and APIs once, then attach MCP integrations to the repositories whose
        reviews and automations should use their tools.
      </p>
      <Notes />

      <SectionHeading
        aside={
          data.connections.length > 0 ? (
            <span className="text-xs text-mute tabular-nums">
              {data.connections.length} connected
            </span>
          ) : null
        }
      >
        Connected
      </SectionHeading>
      {data.connections.length === 0 ? (
        <EmptyState>No integrations yet — add your first with “New integration”.</EmptyState>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map(({ installation, connections, repos }) => (
            <section key={installation.id} className="flex flex-col gap-2">
              {multiInstall ? (
                <Placard className="px-0.5">{installation.account_login}</Placard>
              ) : null}
              {connections.map((conn) => (
                <IntegrationCard key={conn.id} conn={conn} repos={repos} />
              ))}
            </section>
          ))}
        </div>
      )}
    </>
  );
}
