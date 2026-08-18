import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import {
  Bell,
  Clapperboard,
  GitCompare,
  GitMerge,
  OctagonMinus,
  RefreshCw,
  Search,
  Wrench,
} from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import type { ApiRepoSettings, ApiSettings } from '../../shared/api-types.ts';
import { api, ApiError } from '../lib/api.ts';
import { pushSupported, subscribeToPush, unsubscribeFromPush } from '../lib/push.ts';
import { meQuery, settingsQuery } from '../lib/queries.ts';
import { EmptyState, Muted, PageTitle, SectionHeading } from '../components/section.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card } from '../components/ui/card.tsx';
import { Input } from '../components/ui/input.tsx';
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
      api.patch(`/api/repos/${repoId}`, patch),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: ['settings'] });
      const prev = queryClient.getQueryData<ApiSettings>(['settings']);
      if (prev) {
        queryClient.setQueryData<ApiSettings>(['settings'], {
          ...prev,
          installations: prev.installations.map((inst) => ({
            ...inst,
            repos: inst.repos.map((r) => (r.id === repoId ? { ...r, ...patch } : r)),
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

function RepoRow({ repo }: { repo: ApiRepoSettings }) {
  const queryClient = useQueryClient();
  const patchRepo = usePatchRepo(repo.id);
  const toggleAgent = useMutation({
    mutationFn: ({ agentId, enabled }: { agentId: number; enabled: boolean }) =>
      api.put(`/api/repos/${repo.id}/agents/${agentId}`, { enabled }),
    onMutate: async ({ agentId, enabled }) => {
      await queryClient.cancelQueries({ queryKey: ['settings'] });
      const prev = queryClient.getQueryData<ApiSettings>(['settings']);
      if (prev) {
        queryClient.setQueryData<ApiSettings>(['settings'], {
          ...prev,
          installations: prev.installations.map((inst) => ({
            ...inst,
            repos: inst.repos.map((r) =>
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
      api.put(`/api/repos/${repo.id}/skills/${skillId}`, { enabled }),
    onMutate: async ({ skillId, enabled }) => {
      await queryClient.cancelQueries({ queryKey: ['settings'] });
      const prev = queryClient.getQueryData<ApiSettings>(['settings']);
      if (prev) {
        queryClient.setQueryData<ApiSettings>(['settings'], {
          ...prev,
          installations: prev.installations.map((inst) => ({
            ...inst,
            repos: inst.repos.map((r) =>
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

  return (
    <Card className="mt-2">
      <div className="flex items-center justify-between gap-3">
        <span
          className="min-w-0 truncate font-mono font-medium"
          title={`${repo.owner}/${repo.name}`}
        >
          <span className="text-mute">{repo.owner}/</span>
          {repo.name}
        </span>
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

      {repo.enabled ? (
        <div className="mt-3 flex flex-col gap-2 border-t border-line/70 pt-3">
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
              title={`${repo.review_on_push ? 'Stop' : 'Start'} re-reviewing this repo's factory PRs when new commits are pushed (debounced)`}
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
            <Chip
              on={repo.auto_fix}
              title={`${repo.auto_fix ? 'Blocking reviews are left for a human to address' : 'A blocking review dispatches the fix agent to address the findings (max 3 runs per PR)'} — click to ${repo.auto_fix ? 'disable' : 'enable'}`}
              onClick={() => patchRepo.mutate({ auto_fix: !repo.auto_fix })}
            >
              <Wrench className="size-3" aria-hidden /> Auto-fix
            </Chip>
            <Chip
              on={repo.auto_merge}
              title={`${repo.auto_merge ? 'Factory PRs stay open for a human to merge' : 'Factory PRs merge automatically once verification passes and the review is clean (requires blocking reviews)'} — click to ${repo.auto_merge ? 'disable' : 'enable'}`}
              onClick={() => patchRepo.mutate({ auto_merge: !repo.auto_merge })}
            >
              <GitMerge className="size-3" aria-hidden /> Auto-merge
            </Chip>
            <Chip
              on={repo.auto_resolve_conflicts}
              title={`${repo.auto_resolve_conflicts ? 'Conflicts are left for a human to resolve' : 'A detected merge conflict dispatches the fix agent to merge the base branch in and push a resolution'} — click to ${repo.auto_resolve_conflicts ? 'disable' : 'enable'}`}
              onClick={() =>
                patchRepo.mutate({ auto_resolve_conflicts: !repo.auto_resolve_conflicts })
              }
            >
              <GitCompare className="size-3" aria-hidden /> Auto-resolve conflicts
            </Chip>
            <Chip
              on={repo.demo_videos}
              title={`${repo.demo_videos ? 'Verification records a short demo video of each feature (the verify agent auto-detects how to launch the app)' : 'Verification skips demo recordings for this repo'} — click to ${repo.demo_videos ? 'disable' : 'enable'}`}
              onClick={() => patchRepo.mutate({ demo_videos: !repo.demo_videos })}
            >
              <Clapperboard className="size-3" aria-hidden /> Demos
            </Chip>
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
    navigator.serviceWorker.ready
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
      return { next, ok: await subscribeToPush(me.vapid_public_key) };
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
  const unconfigured = !me.vapid_public_key;

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
  const installations = data.installations
    .map((inst) => ({
      ...inst,
      repos: q
        ? inst.repos.filter((r) => `${r.owner}/${r.name}`.toLowerCase().includes(q))
        : inst.repos,
    }))
    // While searching, orgs with no matches drop out entirely.
    .filter((inst) => !q || inst.repos.length > 0);
  const repoCount = data.installations.reduce((n, i) => n + i.repos.length, 0);

  return (
    <>
      <PageTitle
        aside={
          <a
            href={`https://github.com/apps/${data.github_app_slug}/installations/new`}
            className="text-[0.85rem] text-accent-bright hover:underline"
          >
            Add or manage repositories on GitHub &rarr;
          </a>
        }
      >
        Settings
      </PageTitle>

      <div className="mt-6">
        <NotificationsSettings />
      </div>

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

      {data.installations.length === 0 ? (
        <div className="mt-6">
          <EmptyState>
            No installations yet — install the app on an organization or account, then come back
            here.
          </EmptyState>
        </div>
      ) : installations.length === 0 ? (
        <div className="mt-6">
          <EmptyState>No repositories match “{query.trim()}”.</EmptyState>
        </div>
      ) : (
        installations.map((inst) => (
          <section key={inst.id}>
            <SectionHeading
              aside={
                <div className="flex items-center gap-3">
                  {inst.account_type === 'Organization' ? (
                    <Link
                      to="/settings/members/$installationId"
                      params={{ installationId: String(inst.id) }}
                      className="text-accent-bright hover:underline"
                    >
                      Members
                    </Link>
                  ) : null}
                  <Muted className="text-xs">
                    {inst.repos.length} {inst.repos.length === 1 ? 'repo' : 'repos'}
                  </Muted>
                </div>
              }
            >
              {inst.account_login} {inst.suspended ? <Pill tone="red">Suspended</Pill> : null}
            </SectionHeading>
            {inst.repos.length === 0 ? (
              <Muted>No repositories selected in this installation.</Muted>
            ) : (
              inst.repos.map((r) => <RepoRow key={r.id} repo={r} />)
            )}
          </section>
        ))
      )}
    </>
  );
}
