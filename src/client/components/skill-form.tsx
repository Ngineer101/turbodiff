import { Link } from '@tanstack/react-router';
import { ArrowLeft, Check } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { EntityFormLayout, FormSection } from './entity-form.tsx';
import { Button } from './ui/button.tsx';
import { Field, Input, Textarea } from './ui/input.tsx';

export interface SkillFormValues {
  name: string;
  slug: string;
  description: string;
  instructions: string;
}

// Shared create/edit form. Server-side validation is authoritative; the
// caller surfaces its error message via the `error` prop.
export function SkillForm({
  mode,
  initial,
  slugEditable,
  error,
  busy,
  onSubmit,
  onCancel,
  footerAction,
  provenance,
}: {
  mode: 'new' | 'edit';
  initial: SkillFormValues;
  slugEditable: boolean;
  error: string | null;
  busy: boolean;
  onSubmit: (values: SkillFormValues) => void;
  onCancel: () => void;
  // Optional trailing action (e.g. Delete on edit), pushed to the far right.
  footerAction?: ReactNode;
  // Import-provenance block on imported skills (edit page only).
  provenance?: ReactNode;
}) {
  const [values, setValues] = useState(initial);
  const set = (patch: Partial<SkillFormValues>) => setValues((v) => ({ ...v, ...patch }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit(values);
  };

  return (
    <EntityFormLayout
      kind="skill"
      title={mode === 'new' ? 'New skill' : 'Edit skill'}
      subtitle="An extra ability for code generation and fix runs — enable it per repo in settings."
      back={
        <Link
          to="/skills"
          className="inline-flex items-center gap-1.5 py-1 text-xs text-mute hover:text-ink"
        >
          <ArrowLeft className="size-3.5" aria-hidden /> Skills
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

      {provenance ? <FormSection label="Provenance">{provenance}</FormSection> : null}

      <FormSection label="Instructions">
        <Field
          label="Focus instructions"
          className="mt-0"
          hint="runs with full repo write access during code generation — only paste content you trust"
        >
          <Textarea
            value={values.instructions}
            onChange={(e) => set({ instructions: e.target.value })}
            required
          />
        </Field>
      </FormSection>

      {error ? <p className="text-[0.85rem] text-danger">{error}</p> : null}
      <div className="flex items-center gap-2">
        <Button type="submit" loading={busy}>
          {busy ? null : <Check className="size-4" aria-hidden />}
          Save skill
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        {footerAction ? <div className="ml-auto">{footerAction}</div> : null}
      </div>
    </EntityFormLayout>
  );
}
