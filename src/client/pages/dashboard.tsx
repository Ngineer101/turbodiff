import { useSuspenseQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { fmtDuration, fmtTokens, fmtUsd, monthLabel } from '../lib/format.ts';
import { dashboardQuery, meQuery } from '../lib/queries.ts';
import { ReviewsTable } from '../components/reviews-table.tsx';
import { EmptyState, Muted, PageTitle, SectionHeading } from '../components/section.tsx';
import { StatTile } from '../components/stat-tile.tsx';
import { Pill } from '../components/ui/pill.tsx';
import { Table, Td, Th } from '../components/ui/table.tsx';

export function DashboardPage() {
	const { data } = useSuspenseQuery(dashboardQuery);
	const { data: me } = useSuspenseQuery(meQuery);
	const maxMonthCost = Math.max(...data.months.map((m) => m.cost_usd), 0);

	return (
		<>
			<PageTitle>dashboard</PageTitle>

			<div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
				<StatTile
					index={0}
					label="cost this month"
					value={fmtUsd(data.stats.month_cost_usd)}
					sub={monthLabel(data.month)}
				/>
				<StatTile
					index={1}
					label="reviews this month"
					value={data.stats.month_reviews}
					sub={
						data.stats.running > 0 ? (
							<span className="text-accent-bright">{data.stats.running} running now</span>
						) : undefined
					}
				/>
				<StatTile
					index={2}
					label="avg review time"
					value={data.stats.avg_duration_s !== null ? fmtDuration(data.stats.avg_duration_s) : '—'}
					sub={
						<>
							{fmtTokens(data.stats.month_tokens)} tokens
							{data.stats.avg_findings !== null
								? ` · ${data.stats.avg_findings.toFixed(1)} findings/review`
								: ''}
						</>
					}
				/>
				<StatTile
					index={3}
					label="connected repos"
					value={data.repo_count}
					sub={`${data.enabled_count} with the factory on`}
				/>
			</div>

			<SectionHeading>monthly cost</SectionHeading>
			{data.months.length === 0 ? (
				<EmptyState>No reviews yet — costs will accumulate here per calendar month.</EmptyState>
			) : (
				<Table>
					<thead>
						<tr>
							<Th>month</Th>
							<Th className="w-2/5" />
							<Th numeric>cost</Th>
							<Th numeric>reviews</Th>
							<Th numeric>tokens</Th>
						</tr>
					</thead>
					<tbody>
						{data.months.map((m) => (
							<tr key={m.month}>
								<Td className="whitespace-nowrap">{monthLabel(m.month)}</Td>
								<Td>
									<span
										className="block h-3.5 min-w-0.5 rounded-r bg-accent/80"
										style={{
											width: `${maxMonthCost > 0 ? Math.max(1, Math.round((m.cost_usd / maxMonthCost) * 100)) : 1}%`,
										}}
									/>
								</Td>
								<Td numeric>{fmtUsd(m.cost_usd)}</Td>
								<Td numeric>{m.reviews}</Td>
								<Td numeric>{fmtTokens(m.total_tokens)}</Td>
							</tr>
						))}
					</tbody>
				</Table>
			)}

			{data.agent_usage.length > 0 ? (
				<>
					<SectionHeading aside={<Muted>{monthLabel(data.month)}</Muted>}>cost by agent</SectionHeading>
					<Table>
						<thead>
							<tr>
								<Th>agent</Th>
								<Th numeric>reviews</Th>
								<Th numeric>cost</Th>
							</tr>
						</thead>
						<tbody>
							{data.agent_usage.map((a) => (
								<tr key={a.agent_slug ?? '(none)'}>
									<Td>{a.agent_slug ?? <Muted>(pre-agent reviews)</Muted>}</Td>
									<Td numeric>{a.reviews}</Td>
									<Td numeric>{a.cost_usd > 0 ? fmtUsd(a.cost_usd) : <Muted>—</Muted>}</Td>
								</tr>
							))}
						</tbody>
					</Table>
				</>
			) : null}

			<SectionHeading
				aside={
					data.recent_reviews.length > 0 ? (
						<Link
							to="/reviews"
							search={{ page: 1 }}
							className="text-[0.85rem] text-accent-bright hover:underline"
						>
							view all reviews &rarr;
						</Link>
					) : undefined
				}
			>
				recent reviews
			</SectionHeading>
			{data.recent_reviews.length === 0 ? (
				<EmptyState>
					No reviews yet — factory-generated pull requests are reviewed automatically and show up
					here.
				</EmptyState>
			) : (
				<ReviewsTable reviews={data.recent_reviews} />
			)}

			<SectionHeading
				aside={
					data.repo_count > 0 ? (
						<Link to="/settings" className="text-[0.85rem] text-accent-bright hover:underline">
							view all repos &rarr;
						</Link>
					) : undefined
				}
			>
				repositories
			</SectionHeading>
			{data.repo_count === 0 ? (
				<EmptyState>
					No installations yet —{' '}
					<a
						href={`https://github.com/apps/${me.github_app_slug}/installations/new`}
						className="text-accent-bright hover:underline"
					>
						install the app
					</a>{' '}
					on an organization or account.
				</EmptyState>
			) : (
				<Table>
					<thead>
						<tr>
							<Th>repository</Th>
							<Th>factory</Th>
							<Th numeric>reviews ({monthLabel(data.month)})</Th>
							<Th numeric>cost ({monthLabel(data.month)})</Th>
						</tr>
					</thead>
					<tbody>
						{data.recent_repos.map((r) => (
							<tr key={r.id}>
								<Td>
									{r.owner}/{r.name} {r.suspended ? <Pill tone="red">suspended</Pill> : null}
								</Td>
								<Td>{r.enabled ? <Pill tone="on">on</Pill> : <Pill>off</Pill>}</Td>
								<Td numeric>{r.reviews > 0 ? r.reviews : <Muted>0</Muted>}</Td>
								<Td numeric>{r.cost_usd > 0 ? fmtUsd(r.cost_usd) : <Muted>—</Muted>}</Td>
							</tr>
						))}
					</tbody>
				</Table>
			)}
		</>
	);
}
