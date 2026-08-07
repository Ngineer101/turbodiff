import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import type { ApiConnection, ApiConnectionTest } from '../../shared/api-types.ts';
import { api, ApiError } from '../lib/api.ts';
import { agentQuery } from '../lib/queries.ts';
import { AgentForm, type AgentFormValues } from '../components/agent-form.tsx';
import { ConfirmButton } from '../components/confirm-button.tsx';
import { Muted, PageTitle, SectionHeading } from '../components/section.tsx';
import { Button } from '../components/ui/button.tsx';
import { Dialog, DialogContent, DialogTitle } from '../components/ui/dialog.tsx';
import { Field, Input } from '../components/ui/input.tsx';
import { Pill } from '../components/ui/pill.tsx';
import { Table, Td, Th } from '../components/ui/table.tsx';

function onApiError(err: unknown) {
	toast.error(err instanceof ApiError ? err.message : 'request failed');
}

function ConnectionTestDialog({
	result,
	name,
	onClose,
}: {
	result: ApiConnectionTest;
	name: string;
	onClose: () => void;
}) {
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-w-lg">
				<DialogTitle className="text-base font-medium">
					connection test <Pill>{name}</Pill>
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

function ConnectionsSection({ agentId, connections }: { agentId: number; connections: ApiConnection[] }) {
	const queryClient = useQueryClient();
	const refresh = () => queryClient.invalidateQueries({ queryKey: ['agent', agentId] });
	const [form, setForm] = useState({ name: '', url: '', token: '', tools: '' });
	const [error, setError] = useState<string | null>(null);
	const [test, setTest] = useState<{ name: string; result: ApiConnectionTest } | null>(null);

	const add = useMutation({
		mutationFn: () => api.post(`/api/agents/${agentId}/connections`, form),
		onSuccess: () => {
			setForm({ name: '', url: '', token: '', tools: '' });
			setError(null);
			toast.success('connection added');
			refresh();
		},
		onError: (err) => setError(err instanceof ApiError ? err.message : 'request failed'),
	});
	const remove = useMutation({
		mutationFn: (cid: number) => api.delete(`/api/agents/${agentId}/connections/${cid}`),
		onSuccess: () => {
			toast.success('connection removed');
			refresh();
		},
		onError: onApiError,
	});
	const runTest = useMutation({
		mutationFn: (conn: ApiConnection) =>
			api
				.post<ApiConnectionTest>(`/api/agents/${agentId}/connections/${conn.id}/test`)
				.then((result) => ({ name: conn.name, result })),
		onSuccess: (data) => setTest(data),
		onError: onApiError,
	});

	const submit = (e: FormEvent) => {
		e.preventDefault();
		add.mutate();
	};

	return (
		<>
			<SectionHeading aside={<Muted>MCP</Muted>}>external tools</SectionHeading>
			<p className="text-[0.85rem] text-mute">
				Give this agent extra tools by connecting remote MCP servers — e.g. your{' '}
				<a href="https://executor.sh" className="text-accent-bright hover:underline">
					Executor
				</a>{' '}
				catalog endpoint (one URL + token for all your integrations, with per-tool policies managed
				there). Tokens are encrypted and write-only. Anything a connected server returns is treated
				as untrusted content, and a connected server does see PR context the agent sends it —
				connect only servers you control or trust.
			</p>

			{connections.length > 0 ? (
				<Table>
					<thead>
						<tr>
							<Th>server</Th>
							<Th>tools</Th>
							<Th>auth</Th>
							<Th numeric />
						</tr>
					</thead>
					<tbody>
						{connections.map((conn) => (
							<tr key={conn.id}>
								<Td>
									<Pill>{conn.name}</Pill>
									<div className="text-xs break-all text-mute">{conn.url}</div>
								</Td>
								<Td>
									<Muted>{conn.tools ? conn.tools.join(', ') : 'all tools'}</Muted>
								</Td>
								<Td>{conn.has_auth ? <Pill tone="on">token set</Pill> : <Pill>none</Pill>}</Td>
								<Td numeric>
									<div className="flex justify-end gap-1.5">
										<Button
											size="sm"
											variant="secondary"
											onClick={() => runTest.mutate(conn)}
											loading={runTest.isPending && runTest.variables?.id === conn.id}
										>
											Test
										</Button>
										<ConfirmButton
											size="sm"
											variant="secondary"
											title="Remove this connection?"
											description={`The agent loses access to "${conn.name}" tools on its next run.`}
											confirmLabel="Remove"
											onConfirm={() => remove.mutate(conn.id)}
											busy={remove.isPending && remove.variables === conn.id}
										>
											Remove
										</ConfirmButton>
									</div>
								</Td>
							</tr>
						))}
					</tbody>
				</Table>
			) : (
				<Muted className="mt-2 block">No connections yet.</Muted>
			)}

			<form onSubmit={submit} className="mt-4">
				<Field label="server name" hint="tools mount as mcp__<name>__<tool>">
					<Input
						value={form.name}
						onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
						required
						maxLength={31}
						placeholder="executor"
					/>
				</Field>
				<Field label="endpoint URL" hint="https; the server's MCP endpoint">
					<Input
						value={form.url}
						onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
						required
						placeholder="https://mcp.executor.sh/..."
					/>
				</Field>
				<Field label="bearer token" hint="optional; stored encrypted, never shown again">
					<Input
						value={form.token}
						onChange={(e) => setForm((f) => ({ ...f, token: e.target.value }))}
						autoComplete="off"
					/>
				</Field>
				<Field label="tool allowlist" hint="optional, comma-separated server tool names; empty = all">
					<Input
						value={form.tools}
						onChange={(e) => setForm((f) => ({ ...f, tools: e.target.value }))}
						placeholder="search_deps, check_license"
					/>
				</Field>
				{error ? <p className="mt-4 text-[0.85rem] text-danger">{error}</p> : null}
				<div className="mt-5">
					<Button type="submit" loading={add.isPending}>
						Add connection
					</Button>
				</div>
			</form>

			{test ? (
				<ConnectionTestDialog result={test.result} name={test.name} onClose={() => setTest(null)} />
			) : null}
		</>
	);
}

export function AgentEditPage() {
	const { agentId } = useParams({ from: '/agents/$agentId/edit' });
	const id = Number(agentId);
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const { data } = useSuspenseQuery(agentQuery(id));
	const [error, setError] = useState<string | null>(null);

	const save = useMutation({
		mutationFn: (values: AgentFormValues) => api.put(`/api/agents/${id}`, values),
		onSuccess: () => {
			toast.success('agent saved');
			queryClient.invalidateQueries({ queryKey: ['agents'] });
			queryClient.invalidateQueries({ queryKey: ['agent', id] });
			navigate({ to: '/agents' });
		},
		onError: (err) => setError(err instanceof ApiError ? err.message : 'request failed'),
	});
	const remove = useMutation({
		mutationFn: () => api.delete(`/api/agents/${id}`),
		onSuccess: () => {
			toast.success('agent deleted — its review history stays');
			queryClient.invalidateQueries({ queryKey: ['agents'] });
			navigate({ to: '/agents' });
		},
		onError: onApiError,
	});

	return (
		<>
			<PageTitle
				aside={data.agent.is_builtin ? <Pill>built-in</Pill> : undefined}
			>
				edit agent
			</PageTitle>
			<AgentForm
				initial={{
					name: data.agent.name,
					slug: data.agent.slug,
					description: data.agent.description ?? '',
					instructions: data.agent.instructions,
					model: data.agent.model,
				}}
				slugEditable={false}
				defaultModel={data.default_model}
				error={error}
				busy={save.isPending}
				onSubmit={(values) => save.mutate(values)}
				onCancel={() => navigate({ to: '/agents' })}
			/>
			{!data.agent.is_builtin ? (
				<div className="mt-6 border-t border-line pt-4">
					<ConfirmButton
						variant="danger"
						title="Delete this agent?"
						description="Its review history stays. This cannot be undone."
						confirmLabel="Delete agent"
						onConfirm={() => remove.mutate()}
						busy={remove.isPending}
					>
						Delete agent
					</ConfirmButton>
				</div>
			) : null}
			<ConnectionsSection agentId={id} connections={data.connections} />
		</>
	);
}
