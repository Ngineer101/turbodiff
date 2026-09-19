import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  BarChart2,
  Bell,
  ChevronRight,
  Code,
  ExternalLink,
  FolderGit2,
  OctagonMinus,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Users,
} from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import type { ApiRepoSettings, ApiSettings } from '../types.ts';
import { cloneCommand } from '../../shared/projects.ts';
import { ApiError } from '../lib/api.ts';
import {
  createCloneCredential,
  setRepositoryAgent,
  setRepositorySkill,
  updateRepositorySettings,
} from '../lib/backend.ts';
import { PROCESS_PROFILES } from '../lib/process-profiles.ts';
import { pushSupported, subscribeToPush, unsubscribeFromPush } from '../lib/push.ts';
import { meQuery, settingsQuery } from '../lib/queries.ts';
import { EmptyState, Muted, SectionHeading } from '../components/section.tsx';
import { Button, buttonVariants } from '../components/ui/button.tsx';
import { Card } from '../components/ui/card.tsx';
import { IconTile } from '../components/ui/entity-icon.tsx';
import { Input, Select } from '../components/ui/input.tsx';
import { Pill } from '../components/ui/pill.tsx';
import { Switch } from '../components/ui/switch.tsx';
import { cn } from '../lib/utils.ts';

function onApiError<T>(err: T) {
  toast.error(err instanceof ApiError ? err.message : 'Request failed');
}

// Optimistically patch one repo row in the settings cache; invalidate on
// settle so the server stays authoritative.
function usePatchRepo(repoId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<ApiRepoSettings> & { check_command?: string }) =>
      updateRepositorySettings(repoId, patch),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: ['settings'] });
      const prev = queryClient.getQueryData<ApiSettings>(['settings']);
      if (prev) {
        queryClient.setQueryData<ApiSettings>(['settings'], {
          ...prev,
          organizations: prev.organizations.map((organization) => ({
            ...organization,
            repos: organization.repos.map((r) => (r.id === repoId ? { ...r, ...patch } : r)),
          })),
        });
      }
      return { prev };
    },
    onError: (err, _patch, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(['settings'], ctx.prev);
      onApiError(err);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['settings'] }),
  });
}

// A toggle chip: the on-state reads at a glance (filled accent) instead of
// only a border-color change.
function Chip({
  on,
  title,
  onClick,
  children,
}: {
  on: boolean;
  title: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        'inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs whitespace-nowrap transition-colors max-sm:px-3.5 max-sm:py-2',
        on
          ? 'border-accent/40 bg-accent/10 text-accent-bright'
          : 'border-line-2/70 text-mute hover:border-line-2 hover:text-ink-dim',
      )}
    >
      {children}
    </button>
  );
}

// The collapsed-row summary: process profile + enabled counts + the behaviors
// that are on — enough to know a repo's setup without expanding it.
function repoSummary(repo: ApiRepoSettings): string {
  const label =
    PROCESS_PROFILES.find((p) => p.value === repo.process_profile)?.label ?? repo.process_profile;
  const agents = repo.agents.filter((a) => a.enabled).length;
  const skills = repo.skills.filter((s) => s.enabled).length;
  const flags = [
    repo.review_on_push &&
      (repo.review_push_debounce_minutes > 0
        ? `on push (${repo.review_push_debounce_minutes}m)`
        : 'on push'),
    repo.blocking_reviews && 'blocking',
    repo.auto_fix && 'auto-fix',
    repo.auto_merge && 'auto-merge',
  ].filter(Boolean);
  const parts = [label, `${agents} agent${agents === 1 ? '' : 's'}`];
  if (skills > 0) parts.push(`${skills} skill${skills === 1 ? '' : 's'}`);
  if (flags.length > 0) parts.push(flags.join(', '));
  return parts.join(' · ');
}

// Label column for one config group inside a repo card.
function ConfigRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="w-14 shrink-0 pt-1.5 text-right font-mono text-[10px] tracking-[0.12em] text-mute/70 uppercase">
        {label}
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

function CheckCommandForm({ repo }: { repo: ApiRepoSettings }) {
  const patchRepo = usePatchRepo(repo.id);
  const [command, setCommand] = useState(repo.check_command ?? '');
  const dirty = command !== (repo.check_command ?? '');
  const save = (e: FormEvent) => {
    e.preventDefault();
    patchRepo.mutate(
      { check_command: command },
      { onSuccess: () => toast.success('Check command saved') },
    );
  };
  return (
    <form onSubmit={save} className="flex w-full items-center gap-1.5">
      <Input
        value={command}
        onChange={(e) => setCommand(e.target.value)}
        placeholder="npm ci && npm test — blocks factory pushes on failure"
        aria-label={`Check command for ${repo.owner}/${repo.name}`}
        className="py-1 font-mono text-xs sm:text-xs"
      />
      {dirty ? (
        <Button size="sm" variant="secondary" type="submit" loading={patchRepo.isPending}>
          Save
        </Button>
      ) : null}
    </form>
  );
}

// The trailing window a push waits before its re-review runs (a newer push
// in the window supersedes it). Saved on submit, like the check command.

function RepoRow({ repo }: { repo: ApiRepoSettings }) {
  const queryClient = useQueryClient();
  const patchRepo = usePatchRepo(repo.id);
  const toggleAgent = useMutation({
    mutationFn: ({ agentId, enabled }: { agentId: number; enabled: boolean }) =>
      setRepositoryAgent(repo.id, agentId, enabled),
    onMutate: async ({ agentId, enabled }) => {
      await queryClient.cancelQueries({ queryKey: ['settings'] });
      const prev = queryClient.getQueryData<ApiSettings>(['settings']);
      if (prev) {
        queryClient.setQueryData<ApiSettings>(['settings'], {
          ...prev,
          organizations: prev.organizations.map((organization) => ({
            ...organization,
            repos: organization.repos.map((r) =>
              r.id === repo.id
                ? { ...r, agents: r.agents.map((a) => (a.id === agentId ? { ...a, enabled } : a)) }
                : r,
            ),
          })),
        });
      }
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(['settings'], ctx.prev);
      onApiError(err);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['settings'] }),
  });
  const toggleSkill = useMutation({
    mutationFn: ({ skillId, enabled }: { skillId: number; enabled: boolean }) =>
      setRepositorySkill(repo.id, skillId, enabled),
    onMutate: async ({ skillId, enabled }) => {
      await queryClient.cancelQueries({ queryKey: ['settings'] });
      const prev = queryClient.getQueryData<ApiSettings>(['settings']);
      if (prev) {
        queryClient.setQueryData<ApiSettings>(['settings'], {
          ...prev,
          organizations: prev.organizations.map((organization) => ({
            ...organization,
            repos: organization.repos.map((r) =>
              r.id === repo.id
                ? { ...r, skills: r.skills.map((s) => (s.id === skillId ? { ...s, enabled } : s)) }
                : r,
            ),
          })),
        });
      }
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(['settings'], ctx.prev);
      onApiError(err);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['settings'] }),
  });

  const cloneToken = useMutation({
    mutationFn: () => createCloneCredential(repo.id, 'read'),
    onSuccess: (credential) => {
      void navigator.clipboard.writeText(cloneCommand(credential.remote, credential.token));
      toast.success('Clone command copied to clipboard (token valid 24h)');
    },
    onError: onApiError,
  });

  const [open, setOpen] = useState(false);
  const selectedProfile = PROCESS_PROFILES.find((p) => p.value === repo.process_profile);
  const profileOptions = PROCESS_PROFILES.filter(
    (p) => p.value !== 'full_delivery' || repo.provider === 'github',
  );
  // The icon tile + name + one-line summary — shared between the collapsed
  // toggle button (enabled) and the static row (factory off).
  const nameBlock = (
    <>
      <IconTile icon={FolderGit2} size="sm" className={cn(!repo.enabled && 'opacity-60')} />
      <div className="min-w-0">
        <div className="truncate font-mono text-sm font-medium">
          <span className="text-mute">{repo.owner}/</span>
          {repo.name}
          {repo.provider === 'artifacts' ? (
            <Pill tone={repo.enabled ? 'on' : 'neutral'} className="ml-2">
              Artifacts
            </Pill>
          ) : null}
        </div>
        <div className="truncate text-xs text-mute">
          {repo.enabled ? repoSummary(repo) : 'Factory off'}
        </div>
      </div>
    </>
  );

  return (
    <Card className="mt-2 overflow-hidden p-0">
      <div className="flex items-center gap-2 px-3.5 py-3">
        {repo.enabled ? (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left"
          >
            <ChevronRight
              className={cn('size-4 shrink-0 text-mute transition-transform', open && 'rotate-90')}
              aria-hidden
            />
            {nameBlock}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <span className="size-4 shrink-0" aria-hidden />
            {nameBlock}
          </div>
        )}
        {/* Shown for artifacts repos too — the code page owns the "not yet
            supported" message. */}
        <Link
          to="/repos/$repoId/code/$"
          params={{ repoId: String(repo.id), _splat: '' }}
          className={cn(buttonVariants({ size: 'sm', variant: 'ghost' }), 'shrink-0')}
        >
          <Code className="size-3.5" aria-hidden /> Code
        </Link>
        {repo.provider === 'artifacts' && (
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0"
            loading={cloneToken.isPending}
            onClick={() => cloneToken.mutate()}
          >
            Clone
          </Button>
        )}
        <label className="flex shrink-0 cursor-pointer items-center gap-2 text-xs text-mute">
          Factory
          <Switch
            checked={repo.enabled}
            onCheckedChange={(enabled) =>
              patchRepo.mutate(
                { enabled },
                {
                  onSuccess: () =>
                    toast.success(
                      `Factory ${enabled ? 'enabled' : 'disabled'} for ${repo.owner}/${repo.name}`,
                    ),
                },
              )
            }
            aria-label={`factory for ${repo.owner}/${repo.name}`}
          />
        </label>
      </div>

      {repo.enabled && open ? (
        <div className="flex flex-col gap-3 border-t border-line/70 px-3.5 py-3">
          <ConfigRow label="Agents">
            {repo.agents.map((a) => (
              <Chip
                key={a.id}
                on={a.enabled}
                title={`${a.enabled ? 'Disable' : 'Enable'} ${a.name} on this repo`}
                onClick={() => toggleAgent.mutate({ agentId: a.id, enabled: !a.enabled })}
              >
                {a.slug}
              </Chip>
            ))}
          </ConfigRow>
          <ConfigRow label="Skills">
            {repo.skills.map((s) => (
              <Chip
                key={s.id}
                on={s.enabled}
                title={`${s.enabled ? 'Disable' : 'Enable'} ${s.name} on this repo`}
                onClick={() => toggleSkill.mutate({ skillId: s.id, enabled: !s.enabled })}
              >
                {s.slug}
              </Chip>
            ))}
          </ConfigRow>
          <ConfigRow label="Behavior">
            <Chip
              on={repo.review_on_push}
              title={`${repo.review_on_push ? 'Stop' : 'Start'} re-reviewing open PRs when new commits are pushed`}
              onClick={() => patchRepo.mutate({ review_on_push: !repo.review_on_push })}
            >
              <RefreshCw className="size-3" aria-hidden /> On push
            </Chip>
            <Chip
              on={repo.blocking_reviews}
              title={`${repo.blocking_reviews ? 'Reviews post as plain comments' : 'P1 findings request changes; clean reviews approve'} — click to ${repo.blocking_reviews ? 'disable' : 'enable'}`}
              onClick={() => patchRepo.mutate({ blocking_reviews: !repo.blocking_reviews })}
            >
              <OctagonMinus className="size-3" aria-hidden /> Blocking
            </Chip>
          </ConfigRow>
          <ConfigRow label="Process">
            <div className="w-full max-w-sm">
              <Select
                value={repo.process_profile}
                onChange={(e) => {
                  // The option value is one of profileOptions — read the typed
                  // profile off the list rather than casting the raw string.
                  const p = profileOptions.find((x) => x.value === e.target.value);
                  if (p) patchRepo.mutate({ process_profile: p.value });
                }}
                aria-label={`Process profile for ${repo.owner}/${repo.name}`}
                className="py-1.5 text-xs sm:text-xs"
              >
                {profileOptions.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </Select>
              {selectedProfile ? (
                <p className="mt-1.5 text-xs leading-relaxed text-mute/80">
                  {selectedProfile.description}
                </p>
              ) : null}
            </div>
          </ConfigRow>
          <ConfigRow label="Check">
            <CheckCommandForm repo={repo} />
          </ConfigRow>
        </div>
      ) : null}
    </Card>
  );
}

// User-scoped, unlike ApiSettings (installation/repo scoped) — local
// component state read from the browser's own subscription/permission,
// since the browser's permission prompt can't be re-shown once answered;
// this switch is the only way to revoke.
function NotificationsSettings() {
  const { data: me } = useSuspenseQuery(meQuery);
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!pushSupported()) {
      setLoading(false);
      return;
    }
    void navigator.serviceWorker.ready
      .then((r) => r.pushManager.getSubscription())
      .then((sub) => setEnabled(Notification.permission === 'granted' && sub !== null))
      .finally(() => setLoading(false));
  }, []);

  const toggle = useMutation({
    mutationFn: async (next: boolean) => {
      if (!next) {
        await unsubscribeFromPush();
        return { next, ok: true };
      }
      return { next, ok: await subscribeToPush(me.vapidPublicKey) };
    },
    onSuccess: ({ next, ok }) => {
      if (!ok) {
        toast.error('Notification permission was denied — allow it in your browser site settings');
        return;
      }
      setEnabled(next);
      toast.success(next ? 'Notifications enabled' : 'Notifications disabled');
    },
    // Push fails in browser-specific ways (no VAPID key, a rejecting push
    // service, a dead service worker) — show what actually broke instead of
    // a bare "Request failed".
    onError: (err) =>
      toast.error(err instanceof Error && err.message ? err.message : 'Could not enable push'),
  });

  if (!pushSupported()) return null;
  const unconfigured = !me.vapidPublicKey;

  return (
    <>
      <SectionHeading>Notifications</SectionHeading>
      <Card className="mt-2">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[0.85rem] font-medium">Push notifications</p>
            <p className="mt-0.5 text-xs text-mute">
              {unconfigured
                ? 'Unavailable — this deployment has no VAPID_PUBLIC_KEY set, so browsers cannot subscribe.'
                : 'Get notified on this device when Turbodiff needs your input on a task.'}
            </p>
          </div>
          <label
            className={cn(
              'flex shrink-0 items-center gap-2 text-xs text-mute',
              unconfigured ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
            )}
          >
            <Bell className="size-3.5" aria-hidden />
            <Switch
              checked={enabled}
              disabled={loading || toggle.isPending || unconfigured}
              onCheckedChange={(next) => toggle.mutate(next)}
              aria-label="Push notifications"
            />
          </label>
        </div>
      </Card>
    </>
  );
}

export function SettingsPage() {
  const { data } = useSuspenseQuery(settingsQuery);
  const [query, setQuery] = useState('');

  const q = query.trim().toLowerCase();
  const organizations = data.organizations
    .map((organization) => ({
      ...organization,
      repos: q
        ? organization.repos.filter((r) => `${r.owner}/${r.name}`.toLowerCase().includes(q))
        : organization.repos,
    }))
    .filter((organization) => !q || organization.repos.length > 0);
  const repoCount = data.organizations.reduce(
    (count, organization) => count + organization.repos.length,
    0,
  );

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="flex items-start gap-3">
          <IconTile icon={SlidersHorizontal} size="md" />
          <div>
            <h1 className="text-xl leading-tight font-medium tracking-wide">Settings</h1>
            <p className="mt-1 text-[0.85rem] text-mute">
              Notifications, members, and per-repo factory configuration.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to="/projects/new"
            className={buttonVariants({ variant: 'default', size: 'default' })}
          >
            <Plus className="size-4" aria-hidden /> New project
          </Link>
          <a
            href={`https://github.com/apps/${data.github_app_slug}/installations/new`}
            className={buttonVariants({ variant: 'secondary', size: 'default' })}
          >
            Manage on GitHub <ExternalLink className="size-3.5" aria-hidden />
          </a>
        </div>
      </div>

      {/* Usage has a sidebar slot on desktop; the mobile bottom bar doesn't,
          so Settings carries the link there. */}
      <Card className="mt-6 p-0 md:hidden">
        <Link
          to="/usage"
          className="flex items-center gap-3 px-3.5 py-3 text-[0.85rem] font-medium"
        >
          <IconTile icon={BarChart2} size="sm" />
          <span className="flex-1">Usage</span>
          <ChevronRight className="size-4 text-mute" aria-hidden />
        </Link>
      </Card>

      <div className="mt-6">
        <NotificationsSettings />
      </div>

      {data.organizations.length > 0 ? (
        <>
          <SectionHeading>Members</SectionHeading>
          {data.organizations.map((organization) => (
            <Card key={organization.id} className="mt-2 p-0">
              <Link
                to="/settings/members/$organizationId"
                params={{ organizationId: organization.id }}
                className="flex items-center gap-3 px-3.5 py-3 text-[0.85rem] font-medium"
              >
                <IconTile icon={Users} size="sm" />
                <span className="flex-1">{organization.name}</span>
                <ChevronRight className="size-4 text-mute" aria-hidden />
              </Link>
            </Card>
          ))}
        </>
      ) : null}

      {repoCount > 5 ? (
        <div className="relative mt-5 sm:max-w-sm">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-mute"
            aria-hidden
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${repoCount} repositories…`}
            aria-label="Search repositories"
            className="pl-8 sm:pl-8"
          />
        </div>
      ) : null}

      {data.organizations.length === 0 ? (
        <div className="mt-6">
          <EmptyState>No organizations yet.</EmptyState>
        </div>
      ) : organizations.length === 0 ? (
        <div className="mt-6">
          <EmptyState>No repositories match “{query.trim()}”.</EmptyState>
        </div>
      ) : (
        organizations.map((organization) => (
          <section key={organization.id}>
            <SectionHeading
              aside={
                <Muted className="text-xs">
                  {organization.repos.length} {organization.repos.length === 1 ? 'repo' : 'repos'}
                </Muted>
              }
            >
              {organization.name}{' '}
              {organization.suspended ? <Pill tone="red">Suspended</Pill> : null}
            </SectionHeading>
            {organization.repos.length === 0 ? (
              <Muted>No repositories in this organization.</Muted>
            ) : (
              organization.repos.map((r) => <RepoRow key={r.id} repo={r} />)
            )}
          </section>
        ))
      )}
    </>
  );
}
