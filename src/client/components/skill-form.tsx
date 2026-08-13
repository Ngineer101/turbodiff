import { useState, type FormEvent } from 'react';
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
  initial,
  slugEditable,
  error,
  busy,
  onSubmit,
  onCancel,
}: {
  initial: SkillFormValues;
  slugEditable: boolean;
  error: string | null;
  busy: boolean;
  onSubmit: (values: SkillFormValues) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState(initial);
  const set = (patch: Partial<SkillFormValues>) => setValues((v) => ({ ...v, ...patch }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit(values);
  };

  return (
    <form onSubmit={submit}>
      <Field label="name">
        <Input
          value={values.name}
          onChange={(e) => set({ name: e.target.value })}
          required
          maxLength={60}
        />
      </Field>
      <Field
        label="slug"
        hint={`short identifier; lowercase letters, digits, dashes${slugEditable ? '' : '; fixed after creation'}`}
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
      <Field label="description" hint="shown in lists">
        <Input
          value={values.description}
          onChange={(e) => set({ description: e.target.value })}
          maxLength={200}
        />
      </Field>
      <Field
        label="focus instructions"
        hint="runs with full repo write access during code generation — only paste content you trust"
      >
        <Textarea
          value={values.instructions}
          onChange={(e) => set({ instructions: e.target.value })}
          required
        />
      </Field>
      {error ? <p className="mt-4 text-[0.85rem] text-danger">{error}</p> : null}
      <div className="mt-5 flex gap-2">
        <Button type="submit" loading={busy}>
          Save skill
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
