import { useState, type FormEvent } from 'react';
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
  enabled: boolean;
}

// What actually goes over the wire — time_of_day/day_of_week null out for
// schedule kinds where they don't apply, matching the server's validation.
export interface AutomationSubmitValues {
  name: string;
  repository_id: number;
  prompt: string;
  schedule_kind: 'hourly' | 'daily' | 'weekly';
  time_of_day: string | null;
  day_of_week: number | null;
  enabled: boolean;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function isScheduleKind(value: string): value is AutomationFormValues['schedule_kind'] {
  return value === 'hourly' || value === 'daily' || value === 'weekly';
}

// Shared create/edit form. Server-side validation is authoritative; the
// caller surfaces its error message via the `error` prop.
export function AutomationForm({
  initial,
  repos,
  repoEditable,
  showEnabled,
  error,
  busy,
  onSubmit,
  onCancel,
}: {
  initial: AutomationFormValues;
  repos: { id: number; owner: string; name: string }[];
  repoEditable: boolean;
  showEnabled: boolean;
  error: string | null;
  busy: boolean;
  onSubmit: (values: AutomationSubmitValues) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState(initial);
  const set = (patch: Partial<AutomationFormValues>) => setValues((v) => ({ ...v, ...patch }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit({
      name: values.name,
      repository_id: values.repository_id,
      prompt: values.prompt,
      schedule_kind: values.schedule_kind,
      time_of_day: values.schedule_kind === 'hourly' ? null : values.time_of_day,
      day_of_week: values.schedule_kind === 'weekly' ? values.day_of_week : null,
      enabled: values.enabled,
    });
  };

  return (
    <form onSubmit={submit}>
      <Field label="name">
        <Input
          value={values.name}
          onChange={(e) => set({ name: e.target.value })}
          required
          maxLength={80}
        />
      </Field>
      <Field label="repository" hint={repoEditable ? undefined : 'fixed after creation'}>
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
      <Field label="schedule">
        <Select
          value={values.schedule_kind}
          onChange={(e) => {
            if (isScheduleKind(e.target.value)) set({ schedule_kind: e.target.value });
          }}
        >
          <option value="hourly">Hourly</option>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
        </Select>
      </Field>
      {values.schedule_kind !== 'hourly' ? (
        <Field label="time of day" hint="UTC">
          <Input
            type="time"
            value={values.time_of_day}
            onChange={(e) => set({ time_of_day: e.target.value })}
            required
          />
        </Field>
      ) : null}
      {values.schedule_kind === 'weekly' ? (
        <Field label="day of week">
          <Select
            value={values.day_of_week}
            onChange={(e) => set({ day_of_week: Number(e.target.value) })}
          >
            {DAY_NAMES.map((label, i) => (
              <option key={i} value={i}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      <Field label="prompt" hint="runs with full repo write access — only paste content you trust">
        <Textarea
          value={values.prompt}
          onChange={(e) => set({ prompt: e.target.value })}
          required
        />
      </Field>
      {showEnabled ? (
        <label className="mt-4 flex items-center gap-2.5 text-xs text-mute">
          <Switch checked={values.enabled} onCheckedChange={(v) => set({ enabled: v })} />
          enabled
        </label>
      ) : null}
      {error ? <p className="mt-4 text-[0.85rem] text-danger">{error}</p> : null}
      <div className="mt-5 flex gap-2">
        <Button type="submit" loading={busy}>
          Save automation
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
