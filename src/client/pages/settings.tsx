import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import type { ApiRepoSettings, ApiSettings } from '../../shared/api-types.ts';
import { api, ApiError } from '../lib/api.ts';
import { settingsQuery } from '../lib/queries.ts';
import { EmptyState, Muted, PageTitle, SectionHeading } from '../components/section.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card } from '../components/ui/card.tsx';
import { Input } from '../components/ui/input.tsx';
import { Pill } from '../components/ui/pill.tsx';
import { Switch } from '../components/ui/switch.tsx';
import { cn } from '../lib/utils.ts';

function onApiError(err: unknown) {
	toast.error(err instanceof ApiError ? err.message : 'request failed');
}

// Optimistically patch one repo row in the settings cache; invalidate on
// settle so the server stays authoritative.
function usePatchRepo(repoId: number) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (patch: Partial<ApiRepoSettings> & { check_command?: string }) =>
			api.patch(`/api/repos/${repoId}`, patch),
		onMutate: async (patch) => {
			await queryClient.cancelQueries({ queryKey: ['settings'] });
			const prev = queryClient.getQueryData<ApiSettings>(['settings']);
			if (prev) {
				queryClient.setQueryData<ApiSettings>(['settings'], {
					...prev,
					installations: prev.installations.map((inst) => ({
						...inst,
						repos: inst.repos.map((r) => (r.id === repoId ? { ...r, ...patch } : r)),
					})),
				});
			}
			return { prev };
		},
		onError: (err, _patch, ctx) => {
			if (ctx?.prev) queryClient.setQueryData(['settings'], ctx.prev);
			onApiError(err);
		},
		onSettled: () => queryClient.invalidateQueries({ queryKey: ['settings'] }),
	});
}

function Chip({
	on,
	title,
	onClick,
	children,
}: {
	on: boolean;
	title: string;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			title={title}
			aria-pressed={on}
			onClick={onClick}
			className={cn(
				'cursor-pointer rounded-full border px-2.5 py-px text-xs whitespace-nowrap transition-colors',
				on
					? 'border-accent/40 text-accent-bright'
					: 'border-line-2 text-mute hover:bg-raised',
			)}
		>
			{children}
		</button>
	);
}

function CheckCommandForm({ repo }: { repo: ApiRepoSettings }) {
	const patchRepo = usePatchRepo(repo.id);
	const [command, setCommand] = useState(repo.check_command ?? '');
	const save = (e: FormEvent) => {
		e.preventDefault();
		patchRepo.mutate(
			{ check_command: command },
			{ onSuccess: () => toast.success('check command saved') },
		);
	};
	return (
		<form onSubmit={save} className="mt-2 flex w-full items-center gap-1.5">
			<Input
				value={command}
				onChange={(e) => setCommand(e.target.value)}
				placeholder="check command (e.g. npm ci && npm test) — blocks factory pushes on failure"
				className="py-1 text-xs"
			/>
			<Button size="sm" variant="secondary" type="submit" loading={patchRepo.isPending}>
				save
			</Button>
		</form>
	);
}

function RepoRow({ repo }: { repo: ApiRepoSettings }) {
	const queryClient = useQueryClient();
	const patchRepo = usePatchRepo(repo.id);
	const toggleAgent = useMutation({
		mutationFn: ({ agentId, enabled }: { agentId: number; enabled: boolean }) =>
			api.put(`/api/repos/${repo.id}/agents/${agentId}`, { enabled }),
		onMutate: async ({ agentId, enabled }) => {
			await queryClient.cancelQueries({ queryKey: ['settings'] });
			const prev = queryClient.getQueryData<ApiSettings>(['settings']);
			if (prev) {
				queryClient.setQueryData<ApiSettings>(['settings'], {
					...prev,
					installations: prev.installations.map((inst) => ({
						...inst,
						repos: inst.repos.map((r) =>
							r.id === repo.id
								? { ...r, agents: r.agents.map((a) => (a.id === agentId ? { ...a, enabled } : a)) }
								: r,
						),
					})),
				});
			}
			return { prev };
		},
		onError: (err, _vars, ctx) => {
			if (ctx?.prev) queryClient.setQueryData(['settings'], ctx.prev);
			onApiError(err);
		},
		onSettled: () => queryClient.invalidateQueries({ queryKey: ['settings'] }),
	});

	return (
		<Card className="mt-2">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<span className="font-medium">
					{repo.owner}/{repo.name}
				</span>
				<label className="flex cursor-pointer items-center gap-2 text-xs text-mute">
					auto-review
					<Switch
						checked={repo.enabled}
						onCheckedChange={(enabled) =>
							patchRepo.mutate(
								{ enabled },
								{ onSuccess: () => toast.success(`reviews ${enabled ? 'enabled' : 'disabled'} for ${repo.owner}/${repo.name}`) },
							)
						}
						aria-label={`auto-review for ${repo.owner}/${repo.name}`}
					/>
				</label>
			</div>

			{repo.enabled ? (
				<>
					<div className="mt-3 flex flex-wrap items-center gap-1.5">
						<Muted className="mr-1 text-xs">agents:</Muted>
						{repo.agents.map((a) => (
							<Chip
								key={a.id}
								on={a.enabled}
								title={`${a.enabled ? 'disable' : 'enable'} ${a.name} on this repo`}
								onClick={() => toggleAgent.mutate({ agentId: a.id, enabled: !a.enabled })}
							>
								{a.slug}
							</Chip>
						))}
					</div>
					<div className="mt-2 flex flex-wrap items-center gap-1.5">
						<Muted className="mr-1 text-xs">behavior:</Muted>
						<Chip
							on={repo.review_on_push}
							title={`${repo.review_on_push ? 'stop' : 'start'} re-reviewing this repo's PRs when new commits are pushed (debounced)`}
							onClick={() => patchRepo.mutate({ review_on_push: !repo.review_on_push })}
						>
							&#8635; on push
						</Chip>
						<Chip
							on={repo.blocking_reviews}
							title={`${repo.blocking_reviews ? 'reviews post as plain comments' : 'P1 findings request changes; clean reviews approve'} — click to ${repo.blocking_reviews ? 'disable' : 'enable'}`}
							onClick={() => patchRepo.mutate({ blocking_reviews: !repo.blocking_reviews })}
						>
							&#9940; blocking
						</Chip>
						<Chip
							on={repo.auto_fix}
							title={`${repo.auto_fix ? 'blocking reviews are left for a human to address' : 'a blocking review dispatches the fix agent to address the findings (max 3 runs per PR)'} — click to ${repo.auto_fix ? 'disable' : 'enable'}`}
							onClick={() => patchRepo.mutate({ auto_fix: !repo.auto_fix })}
						>
							&#128295; auto-fix
						</Chip>
						<Chip
							on={repo.auto_merge}
							title={`${repo.auto_merge ? 'factory PRs stay open for a human to merge' : 'factory PRs merge automatically once verification passes and the review is clean (requires blocking reviews)'} — click to ${repo.auto_merge ? 'disable' : 'enable'}`}
							onClick={() => patchRepo.mutate({ auto_merge: !repo.auto_merge })}
						>
							&#127981; auto-merge
						</Chip>
					</div>
					<CheckCommandForm repo={repo} />
				</>
			) : null}
		</Card>
	);
}

export function SettingsPage() {
	const { data } = useSuspenseQuery(settingsQuery);

	return (
		<>
			<PageTitle
				aside={
					<a
						href={`https://github.com/apps/${data.github_app_slug}/installations/new`}
						className="text-[0.85rem] text-accent-bright hover:underline"
					>
						add or manage repositories on GitHub &rarr;
					</a>
				}
			>
				settings
			</PageTitle>

			{data.installations.length === 0 ? (
				<div className="mt-6">
					<EmptyState>
						No installations yet — install the app on an organization or account, then come back here.
					</EmptyState>
				</div>
			) : (
				data.installations.map((inst) => (
					<section key={inst.id}>
						<SectionHeading>
							{inst.account_login} {inst.suspended ? <Pill tone="red">suspended</Pill> : null}
						</SectionHeading>
						{inst.repos.length === 0 ? (
							<Muted>No repositories selected in this installation.</Muted>
						) : (
							inst.repos.map((r) => <RepoRow key={r.id} repo={r} />)
						)}
					</section>
				))
			)}
		</>
	);
}
