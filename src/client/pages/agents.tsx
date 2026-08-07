import { useSuspenseQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { agentsQuery } from '../lib/queries.ts';
import { EmptyState, Muted, PageTitle, SectionHeading } from '../components/section.tsx';
import { Pill } from '../components/ui/pill.tsx';
import { Table, Td, Th } from '../components/ui/table.tsx';

export function AgentsPage() {
	const { data } = useSuspenseQuery(agentsQuery);

	return (
		<>
			<PageTitle>agents</PageTitle>
			<p className="mt-3 text-[0.85rem] text-mute">
				Agents run on every PR of the repos they're enabled for (see{' '}
				<Link to="/settings" className="text-accent-bright hover:underline">
					settings
				</Link>
				), or on demand via{' '}
				<code className="rounded bg-raised px-1 py-0.5 text-xs">@{data.github_app_slug} &lt;slug&gt;</code>{' '}
				in a PR comment.
			</p>

			{data.installations.length === 0 ? (
				<div className="mt-6">
					<EmptyState>No installations yet — install the app on GitHub first.</EmptyState>
				</div>
			) : (
				data.installations.map((inst) => (
					<section key={inst.id}>
						<SectionHeading
							aside={
								<Link
									to="/agents/new"
									search={{ installation: inst.id }}
									className="text-[0.85rem] text-accent-bright hover:underline"
								>
									+ new agent
								</Link>
							}
						>
							{inst.account_login} {inst.suspended ? <Pill tone="red">suspended</Pill> : null}
						</SectionHeading>
						<Table>
							<thead>
								<tr>
									<Th>agent</Th>
									<Th>slug</Th>
									<Th>model</Th>
									<Th numeric />
								</tr>
							</thead>
							<tbody>
								{inst.agents.map((a) => (
									<tr key={a.id}>
										<Td>
											{a.name} {a.is_builtin ? <Pill>built-in</Pill> : null}
											{a.description ? <div className="text-xs text-mute">{a.description}</div> : null}
										</Td>
										<Td>
											<Pill>{a.slug}</Pill>
										</Td>
										<Td>
											<Muted>{a.model.replace('cloudflare/', '')}</Muted>
										</Td>
										<Td numeric>
											<Link
												to="/agents/$agentId/edit"
												params={{ agentId: String(a.id) }}
												className="text-accent-bright hover:underline"
											>
												edit
											</Link>
										</Td>
									</tr>
								))}
							</tbody>
						</Table>
					</section>
				))
			)}
		</>
	);
}
