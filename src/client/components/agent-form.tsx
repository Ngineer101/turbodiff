import { Link } from '@tanstack/react-router';
import { ArrowLeft, Check } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import type { ApiModelOption } from '../../shared/api-types.ts';
import { EntityFormLayout, FormSection } from './entity-form.tsx';
import { Button } from './ui/button.tsx';
import { Field, Input, Select, Textarea } from './ui/input.tsx';

export interface AgentFormValues {
  name: string;
  slug: string;
  description: string;
  instructions: string;
  model: string;
}

// Shared create/edit form. Server-side validation is authoritative; the
// caller surfaces its error message via the `error` prop.
export function AgentForm({
  mode,
  initial,
  slugEditable,
  models,
  defaultModel,
  error,
  busy,
  onSubmit,
  onCancel,
  footerAction,
}: {
  mode: 'new' | 'edit';
  initial: AgentFormValues;
  slugEditable: boolean;
  // Reviewer options from the catalog (GET /api/models).
  models: ApiModelOption[];
  defaultModel: string;
  error: string | null;
  busy: boolean;
  onSubmit: (values: AgentFormValues) => void;
  onCancel: () => void;
  // Optional trailing action (e.g. Delete on edit), pushed to the far right of
  // the Save / Cancel row.
  footerAction?: ReactNode;
}) {
  const [values, setValues] = useState(initial);
  const set = (patch: Partial<AgentFormValues>) => setValues((v) => ({ ...v, ...patch }));

  // An agent whose stored model predates the catalog still shows (and can
  // re-save) its value; the server allows re-saving it unchanged.
  const modelOptions =
    initial.model && !models.some((m) => m.id === initial.model)
      ? [{ id: initial.model, label: `${initial.model} (not in catalog)` }, ...models]
      : models;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit(values);
  };

  return (
    <EntityFormLayout
      kind="agent"
      title={mode === 'new' ? 'New agent' : 'Edit agent'}
      subtitle="A reviewer persona. It inspects the factory's PRs on the repos it's enabled for; its blocking findings drive the auto-fix loop."
      back={
        <Link
          to="/agents"
          className="inline-flex items-center gap-1.5 py-1 text-xs text-mute hover:text-ink"
        >
          <ArrowLeft className="size-3.5" aria-hidden /> Agents
        </Link>
      }
      onSubmit={submit}
    >
      <FormSection label="Identity">
        <Field label="Name" className="mt-0">
          <Input
            value={values.name}
            onChange={(e) => set({ name: e.target.value })}
            required
            maxLength={60}
          />
        </Field>
        <Field
          label="Slug"
          className="mt-0"
          hint={`lowercase letters, digits, dashes${slugEditable ? '' : '; fixed after creation'}`}
        >
          <Input
            value={values.slug}
            onChange={(e) => set({ slug: e.target.value })}
            readOnly={!slugEditable}
            required
            maxLength={31}
            className="font-mono"
          />
        </Field>
        <Field label="Description" className="mt-0" hint="shown in lists">
          <Input
            value={values.description}
            onChange={(e) => set({ description: e.target.value })}
            maxLength={200}
          />
        </Field>
      </FormSection>

      <FormSection label="Behavior">
        <Field
          label="Focus instructions"
          className="mt-0"
          hint="what this agent hunts for — process and posting rules are fixed"
        >
          <Textarea
            value={values.instructions}
            onChange={(e) => set({ instructions: e.target.value })}
            required
          />
        </Field>
        <Field label="Model" className="mt-0" hint={`default ${defaultModel}`}>
          <Select
            value={values.model}
            onChange={(e) => set({ model: e.target.value })}
            required
            className="font-mono"
          >
            {modelOptions.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </Select>
        </Field>
      </FormSection>

      {error ? <p className="text-[0.85rem] text-danger">{error}</p> : null}
      <div className="flex items-center gap-2">
        <Button type="submit" loading={busy}>
          {busy ? null : <Check className="size-4" aria-hidden />}
          Save agent
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        {footerAction ? <div className="ml-auto">{footerAction}</div> : null}
      </div>
    </EntityFormLayout>
  );
}
