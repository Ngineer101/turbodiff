import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import type { ApiConnectionTest, ApiIntegration } from '../../shared/api-types.ts';
import { api, ApiError } from '../lib/api.ts';
import { integrationsQuery } from '../lib/queries.ts';
import { cn } from '../lib/utils.ts';
import { ConfirmButton } from '../components/confirm-button.tsx';
import { EmptyState, Muted, PageTitle, SectionHeading } from '../components/section.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card } from '../components/ui/card.tsx';
import { Dialog, DialogContent, DialogTitle } from '../components/ui/dialog.tsx';
import { Field, Input, Select } from '../components/ui/input.tsx';
import { Pill } from '../components/ui/pill.tsx';
import { Table, Td, Th } from '../components/ui/table.tsx';

// Central integrations registry: MCP servers (mountable as agent tools) and
// bearer-auth APIs, added once per installation. MCP integrations attach to
// review agents with the toggles on each card.

function onApiError(err: unknown) {
	toast.error(err instanceof ApiError ? err.message : 'request failed');
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
			<DialogContent className="max-w-lg">
				<DialogTitle className="text-base font-medium">
					test <Pill>{name}</Pill>
				</DialogTitle>
				<p className="mt-3 text-[0.85rem]">
					{result.ok ? <Pill tone="on">ok</Pill> : <Pill tone="red">failed</Pill>} {result.detail}
				</p>
				{result.tools.length > 0 ? (
					<Table>
						<thead>
							<tr>
								<Th>tool</Th>
								<Th>mounts as</Th>
							</tr>
						</thead>
						<tbody>
							{result.tools.map((t) => (
								<tr key={t}>
									<Td>{t}</Td>
									<Td>
										<Muted>
											mcp__{name}__{t}
										</Muted>
									</Td>
								</tr>
							))}
						</tbody>
					</Table>
				) : null}
			</DialogContent>
		</Dialog>
	);
}

function IntegrationCard({ conn }: { conn: ApiIntegration }) {
	const queryClient = useQueryClient();
	const { data } = useSuspenseQuery(integrationsQuery);
	const refresh = () => queryClient.invalidateQueries({ queryKey: ['integrations'] });
	const [test, setTest] = useState<ApiConnectionTest | null>(null);
	const agents = data.agents.filter((a) =>
		data.installations.some((i) => i.id === conn.installation_id),
	);

	const runTest = useMutation({
		mutationFn: () => api.post<ApiConnectionTest>(`/api/integrations/${conn.id}/test`),
		onSuccess: setTest,
		onError: onApiError,
	});
	const remove = useMutation({
		mutationFn: () => api.delete(`/api/integrations/${conn.id}`),
		onSuccess: () => {
			toast.success('integration removed');
			refresh();
		},
		onError: onApiError,
	});
	const toggleAgent = useMutation({
		mutationFn: ({ agentId, attached }: { agentId: number; attached: boolean }) =>
			api.put(`/api/integrations/${conn.id}/agents/${agentId}`, { attached }),
		onSuccess: refresh,
		onError: onApiError,
	});

	return (
		<Card className="mt-2">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<span className="flex items-center gap-2">
					<Pill>{conn.kind}</Pill>
					<span className="font-medium">{conn.name}</span>
					{conn.has_auth ? <Pill tone="on">token set</Pill> : <Pill>no auth</Pill>}
				</span>
				<span className="flex gap-1.5">
					<Button size="sm" variant="secondary" onClick={() => runTest.mutate()} loading={runTest.isPending}>
						Test
					</Button>
					<ConfirmButton
						size="sm"
						variant="secondary"
						title="Remove this integration?"
						description={`Agents lose access to "${conn.name}" on their next run. The stored token is deleted.`}
						confirmLabel="Remove"
						onConfirm={() => remove.mutate()}
						busy={remove.isPending}
					>
						Remove
					</ConfirmButton>
				</span>
			</div>
			<div className="mt-1 text-xs break-all text-mute">{conn.url}</div>
			{conn.tools ? (
				<div className="mt-1 text-xs text-mute">tools: {conn.tools.join(', ')}</div>
			) : null}
			{conn.kind === 'mcp' ? (
				<div className="mt-3 flex flex-wrap items-center gap-1.5">
					<Muted className="mr-1 text-xs">agents:</Muted>
					{agents.map((a) => {
						const attached = conn.agent_ids.includes(a.id);
						return (
							<button
								key={a.id}
								type="button"
								aria-pressed={attached}
								title={`${attached ? 'detach from' : 'attach to'} ${a.name}`}
								onClick={() => toggleAgent.mutate({ agentId: a.id, attached: !attached })}
								className={cn(
									'cursor-pointer rounded-full border px-2.5 py-px text-xs whitespace-nowrap transition-colors',
									attached ? 'border-accent/40 text-accent-bright' : 'border-line-2 text-mute hover:bg-raised',
								)}
							>
								{a.slug}
							</button>
						);
					})}
				</div>
			) : (
				<Muted className="mt-2 block text-xs">
					stored API credential — not mounted to agents (MCP integrations are)
				</Muted>
			)}
			{test ? <TestDialog name={conn.name} result={test} onClose={() => setTest(null)} /> : null}
		</Card>
	);
}

function AddForm() {
	const queryClient = useQueryClient();
	const { data } = useSuspenseQuery(integrationsQuery);
	const [form, setForm] = useState({
		installation_id: data.installations[0]?.id ?? 0,
		kind: 'mcp',
		name: '',
		url: '',
		token: '',
		tools: '',
	});
	const [error, setError] = useState<string | null>(null);
	const add = useMutation({
		mutationFn: () => api.post('/api/integrations', form),
		onSuccess: () => {
			setForm((f) => ({ ...f, name: '', url: '', token: '', tools: '' }));
			setError(null);
			toast.success('integration added');
			queryClient.invalidateQueries({ queryKey: ['integrations'] });
		},
		onError: (err) => setError(err instanceof ApiError ? err.message : 'request failed'),
	});
	const submit = (e: FormEvent) => {
		e.preventDefault();
		add.mutate();
	};
	return (
		<form onSubmit={submit}>
			<div className="grid gap-x-4 sm:grid-cols-2">
				<Field label="type">
					<Select value={form.kind} onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))}>
						<option value="mcp">MCP server (agent tools)</option>
						<option value="api">API (bearer-auth endpoint)</option>
					</Select>
				</Field>
				{data.installations.length > 1 ? (
					<Field label="installation">
						<Select
							value={form.installation_id}
							onChange={(e) => setForm((f) => ({ ...f, installation_id: Number(e.target.value) }))}
						>
							{data.installations.map((i) => (
								<option key={i.id} value={i.id}>
									{i.account_login}
								</option>
							))}
						</Select>
					</Field>
				) : null}
			</div>
			<Field label="name" hint={form.kind === 'mcp' ? 'tools mount as mcp__<name>__<tool>' : 'identifier'}>
				<Input
					value={form.name}
					onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
					required
					maxLength={31}
					placeholder="executor"
				/>
			</Field>
			<Field label="endpoint URL" hint="https">
				<Input
					value={form.url}
					onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
					required
					placeholder="https://mcp.example.com/…"
				/>
			</Field>
			<Field label="bearer token" hint="optional; stored encrypted, never shown again">
				<Input
					value={form.token}
					onChange={(e) => setForm((f) => ({ ...f, token: e.target.value }))}
					autoComplete="off"
				/>
			</Field>
			{form.kind === 'mcp' ? (
				<Field label="tool allowlist" hint="optional, comma-separated; empty = all">
					<Input
						value={form.tools}
						onChange={(e) => setForm((f) => ({ ...f, tools: e.target.value }))}
						placeholder="search_deps, check_license"
					/>
				</Field>
			) : null}
			{error ? <p className="mt-4 text-[0.85rem] text-danger">{error}</p> : null}
			<div className="mt-5">
				<Button type="submit" loading={add.isPending}>
					Add integration
				</Button>
			</div>
		</form>
	);
}

export function IntegrationsPage() {
	const { data } = useSuspenseQuery(integrationsQuery);

	return (
		<>
			<PageTitle>mcp &amp; integrations</PageTitle>
			<p className="mt-3 text-[0.85rem] text-mute">
				Connect MCP servers and APIs once, then attach MCP integrations to the agents that should
				use their tools.
			</p>
			<p className="mt-1.5 text-xs text-mute/70">
				Tokens are encrypted and write-only. Connected servers see the PR context agents send them
				and their output is untrusted — connect only servers you control or trust.
			</p>

			<SectionHeading>connected</SectionHeading>
			{data.connections.length === 0 ? (
				<EmptyState>No integrations yet — add one below.</EmptyState>
			) : (
				data.connections.map((conn) => <IntegrationCard key={conn.id} conn={conn} />)
			)}

			<SectionHeading>add integration</SectionHeading>
			<AddForm />
		</>
	);
}
