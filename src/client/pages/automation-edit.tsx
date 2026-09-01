import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { ApiAutomationRunSummary } from '../../shared/api-types.ts';
import { api, ApiError } from '../lib/api.ts';
import { ago } from '../lib/format.ts';
import { automationQuery, automationRunsQuery } from '../lib/queries.ts';
import { AutomationForm, type AutomationSubmitValues } from '../components/automation-form.tsx';
import { ConfirmButton } from '../components/confirm-button.tsx';
import { EmptyState, SectionHeading } from '../components/section.tsx';
import { Button } from '../components/ui/button.tsx';
import { Pill, type PillProps } from '../components/ui/pill.tsx';

function onApiError<T>(err: T) {
  toast.error(err instanceof ApiError ? err.message : 'request failed');
}

const STATUS_TONE = {
  running: 'running',
  pr_opened: 'on',
  no_changes: 'neutral',
  checks_failed: 'warn',
  failed: 'red',
} satisfies Record<string, PillProps['tone']>;

function RunRow({ run, repo }: { run: ApiAutomationRunSummary; repo: string }) {
  return (
    <Link
      to="/automations/runs/$runId"
      params={{ runId: String(run.id) }}
      className="flex items-center justify-between gap-3 rounded-lg bg-raised/40 p-3 transition-colors hover:bg-raised"
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone={STATUS_TONE[run.status] ?? 'neutral'}>{run.status.replaceAll('_', ' ')}</Pill>
          {run.pr_number ? (
            <a
              href={`https://github.com/${repo}/pull/${run.pr_number}`}
              target="_blank"
              rel="noopener"
              onClick={(e) => e.stopPropagation()}
              className="text-xs text-accent-bright hover:underline"
            >
              PR #{run.pr_number}
            </a>
          ) : null}
        </div>
        {run.error ? <p className="mt-1 truncate text-xs text-danger">{run.error}</p> : null}
      </div>
      <span className="shrink-0 text-xs text-mute">{ago(run.created_at)}</span>
    </Link>
  );
}

export function AutomationEditPage() {
  const { automationId } = useParams({ from: '/shell/automations/$automationId/edit' });
  const id = Number(automationId);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data } = useSuspenseQuery(automationQuery(id));
  const { data: runsData } = useQuery(automationRunsQuery(id));
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (values: AutomationSubmitValues) => api.put(`/api/automations/${id}`, values),
    onSuccess: () => {
      toast.success('automation saved');
      queryClient.invalidateQueries({ queryKey: ['automations'] });
      queryClient.invalidateQueries({ queryKey: ['automation', id] });
      navigate({ to: '/automations' });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'request failed'),
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/api/automations/${id}`),
    onSuccess: () => {
      toast.success('automation deleted');
      queryClient.invalidateQueries({ queryKey: ['automations'] });
      navigate({ to: '/automations' });
    },
    onError: onApiError,
  });
  const runNow = useMutation({
    mutationFn: () => api.post(`/api/automations/${id}/run`),
    onSuccess: () => {
      toast.success('run started');
      queryClient.invalidateQueries({ queryKey: ['automation-runs', id] });
    },
    onError: onApiError,
  });

  const repo = `${data.automation.repository.owner}/${data.automation.repository.name}`;

  return (
    <div className="max-w-3xl">
      <AutomationForm
        mode="edit"
        initial={{
          name: data.automation.name,
          repository_id: data.automation.repository.id,
          prompt: data.automation.prompt,
          schedule_kind: data.automation.schedule_kind,
          time_of_day: data.automation.time_of_day ?? '09:00',
          day_of_week: data.automation.day_of_week ?? 1,
          enabled: data.automation.enabled,
        }}
        repos={[data.automation.repository]}
        repoEditable={false}
        showEnabled
        error={error}
        busy={save.isPending}
        onSubmit={(values) => save.mutate(values)}
        onCancel={() => navigate({ to: '/automations' })}
        footerAction={
          <ConfirmButton
            variant="danger"
            title="Delete this automation?"
            description="This cannot be undone."
            confirmLabel="Delete automation"
            onConfirm={() => remove.mutate()}
            busy={remove.isPending}
          >
            <Trash2 className="size-4" aria-hidden /> Delete automation
          </ConfirmButton>
        }
      />

      <SectionHeading
        aside={
          <Button
            size="sm"
            variant="secondary"
            loading={runNow.isPending}
            onClick={() => runNow.mutate()}
          >
            Run now
          </Button>
        }
      >
        Runs
      </SectionHeading>
      {!runsData || runsData.runs.length === 0 ? (
        <EmptyState>No runs yet.</EmptyState>
      ) : (
        <div className="flex flex-col gap-2">
          {runsData.runs.map((r) => (
            <RunRow key={r.id} run={r} repo={repo} />
          ))}
        </div>
      )}
    </div>
  );
}
