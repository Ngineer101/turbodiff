import { useState, type FormEvent } from 'react';
import { Button } from './ui/button.tsx';
import { Field, Input, Textarea } from './ui/input.tsx';

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
	initial,
	slugEditable,
	defaultModel,
	error,
	busy,
	onSubmit,
	onCancel,
}: {
	initial: AgentFormValues;
	slugEditable: boolean;
	defaultModel: string;
	error: string | null;
	busy: boolean;
	onSubmit: (values: AgentFormValues) => void;
	onCancel: () => void;
}) {
	const [values, setValues] = useState(initial);
	const set = (patch: Partial<AgentFormValues>) => setValues((v) => ({ ...v, ...patch }));

	const submit = (e: FormEvent) => {
		e.preventDefault();
		onSubmit(values);
	};

	return (
		<form onSubmit={submit}>
			<Field label="name">
				<Input value={values.name} onChange={(e) => set({ name: e.target.value })} required maxLength={60} />
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
				/>
			</Field>
			<Field label="description" hint="shown in lists">
				<Input
					value={values.description}
					onChange={(e) => set({ description: e.target.value })}
					maxLength={200}
				/>
			</Field>
			<Field label="focus instructions" hint="what this agent hunts for — process and posting rules are fixed">
				<Textarea
					value={values.instructions}
					onChange={(e) => set({ instructions: e.target.value })}
					required
				/>
			</Field>
			<Field label="model" hint={`any AI Gateway model id; default ${defaultModel}`}>
				<Input value={values.model} onChange={(e) => set({ model: e.target.value })} required />
			</Field>
			{error ? <p className="mt-4 text-[0.85rem] text-danger">{error}</p> : null}
			<div className="mt-5 flex gap-2">
				<Button type="submit" loading={busy}>
					Save agent
				</Button>
				<Button type="button" variant="secondary" onClick={onCancel}>
					Cancel
				</Button>
			</div>
		</form>
	);
}
