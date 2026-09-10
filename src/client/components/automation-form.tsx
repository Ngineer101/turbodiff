import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowLeft, Check } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { modelsQuery } from '../lib/queries.ts';
import { EntityFormLayout, FormSection } from './entity-form.tsx';
import { ModelCombobox } from './model-combobox.tsx';
import { Button } from './ui/button.tsx';
import { Field, Input, Select, Textarea } from './ui/input.tsx';
import { Switch } from './ui/switch.tsx';

export interface AutomationFormValues {
  name: string;
  repository_id: number;
  prompt: string;
  schedule_kind: 'hourly' | 'daily' | 'weekly';
  time_of_day: string; // 'HH:MM'; only meaningful for daily/weekly
  day_of_week: number; // 0 (Sun) - 6 (Sat); only meaningful for weekly
  runner_model: string; // '' = deployment default
  enabled: boolean;
}

// What actually goes over the wire — time_of_day/day_of_week null out for
// schedule kinds where they don't apply, matching the server's validation,
// and an untouched model picker rides as null (= deployment default).
export interface AutomationSubmitValues {
  name: string;
  repository_id: number;
  prompt: string;
  schedule_kind: 'hourly' | 'daily' | 'weekly';
  time_of_day: string | null;
  day_of_week: number | null;
  runner_model: string | null;
  enabled: boolean;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function isScheduleKind(value: string): value is AutomationFormValues['schedule_kind'] {
  return value === 'hourly' || value === 'daily' || value === 'weekly';
}

// Shared create/edit form. Server-side validation is authoritative; the
// caller surfaces its error message via the `error` prop.
export function AutomationForm({
  mode,
  initial,
  repos,
  repoEditable,
  showEnabled,
  error,
  busy,
  onSubmit,
  onCancel,
  footerAction,
  readOnly = false,
  readOnlyNotice,
}: {
  mode: 'new' | 'edit';
  initial: AutomationFormValues;
  repos: { id: number; owner: string; name: string }[];
  repoEditable: boolean;
  showEnabled: boolean;
  error: string | null;
  busy: boolean;
  onSubmit: (values: AutomationSubmitValues) => void;
  onCancel: () => void;
  // Optional trailing action (e.g. Delete on edit), pushed to the far right.
  footerAction?: ReactNode;
  readOnly?: boolean;
  readOnlyNotice?: ReactNode;
}) {
  const [values, setValues] = useState(initial);
  const set = (patch: Partial<AutomationFormValues>) => setValues((v) => ({ ...v, ...patch }));

  // app.models is authoritative. Keep model-dependent actions disabled until
  // the catalog arrives instead of presenting a stale source-code fallback.
  const { data: models, error: modelsError } = useQuery(modelsQuery);
  const runnerOptions = models?.runner.options ?? [];
  const runnerDefault = models?.runner.default_model ?? '';
  // An automation whose stored model predates the catalog still shows (and
  // can re-save) its value.
  const modelOptions =
    initial.runner_model && !runnerOptions.some((m) => m.id === initial.runner_model)
      ? [
          { id: initial.runner_model, label: `${initial.runner_model} (not in catalog)` },
          ...runnerOptions,
        ]
      : runnerOptions;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!models) return;
    onSubmit({
      name: values.name,
      repository_id: values.repository_id,
      prompt: values.prompt,
      schedule_kind: values.schedule_kind,
      time_of_day: values.schedule_kind === 'hourly' ? null : values.time_of_day,
      day_of_week: values.schedule_kind === 'weekly' ? values.day_of_week : null,
      runner_model: values.runner_model || null,
      enabled: values.enabled,
    });
  };

  return (
    <EntityFormLayout
      kind="automation"
      title={mode === 'new' ? 'New automation' : 'Edit automation'}
      subtitle="A recurring prompt that runs on a schedule against one repo and opens a PR when it makes changes."
      back={
        <Link
          to="/automations"
          className="inline-flex items-center gap-1.5 py-1 text-xs text-mute hover:text-ink"
        >
          <ArrowLeft className="size-3.5" aria-hidden /> Automations
        </Link>
      }
      onSubmit={submit}
    >
      {readOnlyNotice}
      <FormSection label="Identity">
        <Field label="Name" className="mt-0">
          <Input
            value={values.name}
            onChange={(e) => set({ name: e.target.value })}
            required
            disabled={readOnly}
            maxLength={80}
          />
        </Field>
      </FormSection>

      <FormSection label="Trigger">
        <Field
          label="Repository"
          className="mt-0"
          hint={repoEditable ? undefined : 'fixed after creation'}
        >
          <Select
            value={values.repository_id || ''}
            onChange={(e) => set({ repository_id: Number(e.target.value) })}
            disabled={!repoEditable}
            required
          >
            {repoEditable ? (
              <option value="" disabled>
                Select a repository…
              </option>
            ) : null}
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.owner}/{r.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex flex-wrap gap-4">
          <Field label="Schedule" className="mt-0 min-w-40 flex-1">
            <Select
              value={values.schedule_kind}
              onChange={(e) => {
                if (isScheduleKind(e.target.value)) set({ schedule_kind: e.target.value });
              }}
              disabled={readOnly}
            >
              <option value="hourly">Hourly</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </Select>
          </Field>
          {values.schedule_kind !== 'hourly' ? (
            <Field label="Time of day" className="mt-0 min-w-40 flex-1" hint="UTC">
              <Input
                type="time"
                value={values.time_of_day}
                onChange={(e) => set({ time_of_day: e.target.value })}
                disabled={readOnly}
                required
              />
            </Field>
          ) : null}
          {values.schedule_kind === 'weekly' ? (
            <Field label="Day of week" className="mt-0 min-w-40 flex-1">
              <Select
                value={values.day_of_week}
                onChange={(e) => set({ day_of_week: Number(e.target.value) })}
                disabled={readOnly}
              >
                {DAY_NAMES.map((label, i) => (
                  <option key={i} value={i}>
                    {label}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
        </div>
        {showEnabled ? (
          <label className="flex items-center gap-2.5 text-xs text-mute">
             <Switch disabled={readOnly} checked={values.enabled} onCheckedChange={(v) => set({ enabled: v })} />
            Enabled — the schedule fires while this is on
          </label>
        ) : null}
      </FormSection>

      <FormSection label="Prompt">
        <Field
          label="Prompt"
          className="mt-0"
          hint="runs with full repo write access — only paste content you trust"
        >
          <Textarea
            value={values.prompt}
            onChange={(e) => set({ prompt: e.target.value })}
            required
            disabled={readOnly}
          />
        </Field>
        <Field label="Model" className="mt-0">
          <ModelCombobox
            value={values.runner_model}
            onValueChange={(runner_model) => set({ runner_model })}
            options={modelOptions}
            disabled={!models || readOnly}
            defaultLabel={
              models
                ? `Default (${runnerOptions.find((m) => m.id === runnerDefault)?.label ?? runnerDefault})`
                : undefined
            }
            placeholder={modelsError ? 'Model catalog unavailable' : 'Loading models…'}
            />
        </Field>
      </FormSection>

      {error || modelsError ? (
        <p className="text-[0.85rem] text-danger">
          {error ?? `Model catalog unavailable: ${modelsError?.message}`}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        {!readOnly ? <Button type="submit" loading={busy} disabled={!models}>
          {busy ? null : <Check className="size-4" aria-hidden />}
          Save automation
        </Button> : null}
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        {!readOnly && footerAction ? <div className="ml-auto">{footerAction}</div> : null}
      </div>
    </EntityFormLayout>
  );
}
