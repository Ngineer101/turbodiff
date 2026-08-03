import { env } from 'cloudflare:workers';

// Thin typed layer over the D1 config store (schema in migrations/).

export interface InstallationRow {
	id: number;
	account_login: string;
	account_id: number;
	account_type: string;
	suspended: number;
}

export interface RepositoryRow {
	id: number;
	installation_id: number;
	owner: string;
	name: string;
	enabled: number;
	model: string | null;
	created_at: string; // when the repo was connected (mirrored into D1)
}

interface WebhookAccount {
	login: string;
	id: number;
	type: string;
}

interface WebhookRepo {
	id: number;
	name: string;
	full_name: string;
}

export async function upsertInstallation(id: number, account: WebhookAccount): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO installations (id, account_login, account_id, account_type, suspended)
		 VALUES (?1, ?2, ?3, ?4, 0)
		 ON CONFLICT(id) DO UPDATE SET account_login = ?2, account_id = ?3, account_type = ?4, suspended = 0`,
	)
		.bind(id, account.login, account.id, account.type)
		.run();
}

export async function deleteInstallation(id: number): Promise<void> {
	// D1 doesn't enforce foreign keys by default, so cascade by hand.
	await env.DB.batch([
		env.DB.prepare('DELETE FROM repositories WHERE installation_id = ?1').bind(id),
		env.DB.prepare('DELETE FROM installations WHERE id = ?1').bind(id),
	]);
}

export async function setInstallationSuspended(id: number, suspended: boolean): Promise<void> {
	await env.DB.prepare('UPDATE installations SET suspended = ?2 WHERE id = ?1')
		.bind(id, suspended ? 1 : 0)
		.run();
}

export async function addRepositories(installationId: number, repos: WebhookRepo[]): Promise<void> {
	if (repos.length === 0) return;
	await env.DB.batch(
		repos.map((r) => {
			const [owner, name] = r.full_name.split('/');
			return env.DB.prepare(
				`INSERT INTO repositories (id, installation_id, owner, name)
				 VALUES (?1, ?2, ?3, ?4)
				 ON CONFLICT(id) DO UPDATE SET installation_id = ?2, owner = ?3, name = ?4`,
			).bind(r.id, installationId, owner, name);
		}),
	);
}

export async function removeRepositories(repoIds: number[]): Promise<void> {
	if (repoIds.length === 0) return;
	await env.DB.batch(
		repoIds.map((id) => env.DB.prepare('DELETE FROM repositories WHERE id = ?1').bind(id)),
	);
}

export async function getRepoByFullName(
	owner: string,
	name: string,
): Promise<RepositoryRow | null> {
	return env.DB.prepare('SELECT * FROM repositories WHERE owner = ?1 AND name = ?2')
		.bind(owner, name)
		.first<RepositoryRow>();
}

export async function getInstallation(id: number): Promise<InstallationRow | null> {
	return env.DB.prepare('SELECT * FROM installations WHERE id = ?1')
		.bind(id)
		.first<InstallationRow>();
}

export async function listInstallationsWithRepos(
	installationIds: number[],
): Promise<{ installation: InstallationRow; repos: RepositoryRow[] }[]> {
	if (installationIds.length === 0) return [];
	const placeholders = installationIds.map((_, i) => `?${i + 1}`).join(', ');
	const [installations, repos] = await Promise.all([
		env.DB.prepare(
			`SELECT * FROM installations WHERE id IN (${placeholders}) ORDER BY account_login`,
		)
			.bind(...installationIds)
			.all<InstallationRow>(),
		env.DB.prepare(
			`SELECT * FROM repositories WHERE installation_id IN (${placeholders}) ORDER BY owner, name`,
		)
			.bind(...installationIds)
			.all<RepositoryRow>(),
	]);
	return installations.results.map((installation) => ({
		installation,
		repos: repos.results.filter((r) => r.installation_id === installation.id),
	}));
}

export async function getRepoById(id: number): Promise<RepositoryRow | null> {
	return env.DB.prepare('SELECT * FROM repositories WHERE id = ?1').bind(id).first<RepositoryRow>();
}

export async function setRepoEnabled(id: number, enabled: boolean): Promise<void> {
	await env.DB.prepare('UPDATE repositories SET enabled = ?2 WHERE id = ?1')
		.bind(id, enabled ? 1 : 0)
		.run();
}

export async function recordReview(
	repositoryId: number,
	installationId: number,
	prNumber: number,
	trigger: string,
): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO reviews (repository_id, installation_id, pr_number, trigger_event, status)
		 VALUES (?1, ?2, ?3, ?4, 'running')`,
	)
		.bind(repositoryId, installationId, prNumber, trigger)
		.run();
}

// Called by the post_review tool once the agent has published to GitHub.
// Completes the most recent running review for this repo/PR.
export async function completeReview(
	repositoryId: number,
	prNumber: number,
	reviewUrl: string | null,
): Promise<void> {
	await env.DB.prepare(
		`UPDATE reviews
		 SET status = 'completed', completed_at = datetime('now'), review_url = ?3
		 WHERE id = (
			SELECT id FROM reviews
			WHERE repository_id = ?1 AND pr_number = ?2 AND status = 'running'
			ORDER BY id DESC LIMIT 1
		 )`,
	)
		.bind(repositoryId, prNumber, reviewUrl)
		.run();
}

// Accumulates one model turn's usage onto the latest review row for a PR.
// Fired from the observe() metering subscriber; owner/repo arrive lowercased
// (they come from the agent instance id), hence COLLATE NOCASE.
export async function addReviewUsage(
	owner: string,
	repo: string,
	prNumber: number,
	usage: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
		costUsd: number;
		model: string;
	},
): Promise<void> {
	await env.DB.prepare(
		`UPDATE reviews SET
			input_tokens = input_tokens + ?4,
			output_tokens = output_tokens + ?5,
			cache_read_tokens = cache_read_tokens + ?6,
			cache_write_tokens = cache_write_tokens + ?7,
			cost_usd = cost_usd + ?8,
			model = ?9
		 WHERE id = (
			SELECT r.id FROM reviews r
			JOIN repositories repo ON repo.id = r.repository_id
			WHERE repo.owner = ?1 COLLATE NOCASE AND repo.name = ?2 COLLATE NOCASE
				AND r.pr_number = ?3
			ORDER BY r.id DESC LIMIT 1
		 )`,
	)
		.bind(
			owner,
			repo,
			prNumber,
			usage.inputTokens,
			usage.outputTokens,
			usage.cacheReadTokens,
			usage.cacheWriteTokens,
			usage.costUsd,
			usage.model,
		)
		.run();
}

export interface ReviewActivityRow {
	id: number;
	repository_id: number;
	installation_id: number;
	pr_number: number;
	trigger_event: string;
	status: string;
	created_at: string;
	completed_at: string | null;
	review_url: string | null;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
	cost_usd: number;
	model: string | null;
	repo_owner: string | null; // null if the repo was since removed
	repo_name: string | null;
}

export async function listRecentReviews(
	installationIds: number[],
	limit = 50,
	offset = 0,
): Promise<ReviewActivityRow[]> {
	if (installationIds.length === 0) return [];
	const placeholders = installationIds.map((_, i) => `?${i + 1}`).join(', ');
	const res = await env.DB.prepare(
		`SELECT r.*, repo.owner AS repo_owner, repo.name AS repo_name
		 FROM reviews r
		 LEFT JOIN repositories repo ON repo.id = r.repository_id
		 WHERE r.installation_id IN (${placeholders})
		 ORDER BY r.id DESC
		 LIMIT ${limit} OFFSET ${offset}`,
	)
		.bind(...installationIds)
		.all<ReviewActivityRow>();
	return res.results;
}

export async function countReviews(installationIds: number[]): Promise<number> {
	if (installationIds.length === 0) return 0;
	const placeholders = installationIds.map((_, i) => `?${i + 1}`).join(', ');
	const row = await env.DB.prepare(
		`SELECT COUNT(*) AS n FROM reviews WHERE installation_id IN (${placeholders})`,
	)
		.bind(...installationIds)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

export interface MonthlyUsageRow {
	month: string; // 'YYYY-MM' (UTC)
	reviews: number;
	completed: number;
	total_tokens: number;
	cost_usd: number;
}

export async function monthlyUsage(
	installationIds: number[],
	months = 6,
): Promise<MonthlyUsageRow[]> {
	if (installationIds.length === 0) return [];
	const placeholders = installationIds.map((_, i) => `?${i + 1}`).join(', ');
	const res = await env.DB.prepare(
		`SELECT strftime('%Y-%m', created_at) AS month,
			COUNT(*) AS reviews,
			SUM(status = 'completed') AS completed,
			SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS total_tokens,
			SUM(cost_usd) AS cost_usd
		 FROM reviews
		 WHERE installation_id IN (${placeholders})
		 GROUP BY month
		 ORDER BY month DESC
		 LIMIT ${months}`,
	)
		.bind(...installationIds)
		.all<MonthlyUsageRow>();
	return res.results;
}

export interface RepoUsageRow {
	repository_id: number;
	repo_owner: string | null;
	repo_name: string | null;
	reviews: number;
	total_tokens: number;
	cost_usd: number;
}

// Per-repo usage for one 'YYYY-MM' month, costliest first.
export async function repoUsageForMonth(
	installationIds: number[],
	month: string,
): Promise<RepoUsageRow[]> {
	if (installationIds.length === 0) return [];
	const placeholders = installationIds.map((_, i) => `?${i + 1}`).join(', ');
	const res = await env.DB.prepare(
		`SELECT r.repository_id,
			repo.owner AS repo_owner, repo.name AS repo_name,
			COUNT(*) AS reviews,
			SUM(r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_tokens) AS total_tokens,
			SUM(r.cost_usd) AS cost_usd
		 FROM reviews r
		 LEFT JOIN repositories repo ON repo.id = r.repository_id
		 WHERE r.installation_id IN (${placeholders})
			AND strftime('%Y-%m', r.created_at) = ?${installationIds.length + 1}
		 GROUP BY r.repository_id
		 ORDER BY cost_usd DESC`,
	)
		.bind(...installationIds, month)
		.all<RepoUsageRow>();
	return res.results;
}

export interface DashboardStats {
	month_reviews: number;
	month_cost_usd: number;
	month_tokens: number;
	avg_duration_s: number | null; // completed reviews this month
	running: number;
}

export async function dashboardStats(installationIds: number[]): Promise<DashboardStats> {
	const empty: DashboardStats = {
		month_reviews: 0,
		month_cost_usd: 0,
		month_tokens: 0,
		avg_duration_s: null,
		running: 0,
	};
	if (installationIds.length === 0) return empty;
	const placeholders = installationIds.map((_, i) => `?${i + 1}`).join(', ');
	const row = await env.DB.prepare(
		`SELECT
			COALESCE(SUM(strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')), 0) AS month_reviews,
			COALESCE(SUM(CASE WHEN strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now') THEN cost_usd ELSE 0 END), 0) AS month_cost_usd,
			COALESCE(SUM(CASE WHEN strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
				THEN input_tokens + output_tokens + cache_read_tokens + cache_write_tokens ELSE 0 END), 0) AS month_tokens,
			AVG(CASE WHEN status = 'completed' AND completed_at IS NOT NULL
				AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
				THEN (julianday(completed_at) - julianday(created_at)) * 86400 END) AS avg_duration_s,
			COALESCE(SUM(status = 'running'), 0) AS running
		 FROM reviews
		 WHERE installation_id IN (${placeholders})`,
	)
		.bind(...installationIds)
		.first<DashboardStats>();
	return row ?? empty;
}

// Marks the latest still-running review for a PR as failed. Fired from the
// metering subscriber when the agent's submission settles without post_review
// having completed the row (agent error, abort, or a run that never posted).
// No-op when post_review already flipped the row to completed.
export async function markReviewFailed(
	owner: string,
	repo: string,
	prNumber: number,
): Promise<void> {
	await env.DB.prepare(
		`UPDATE reviews SET status = 'failed', completed_at = datetime('now')
		 WHERE id = (
			SELECT r.id FROM reviews r
			JOIN repositories repo ON repo.id = r.repository_id
			WHERE repo.owner = ?1 COLLATE NOCASE AND repo.name = ?2 COLLATE NOCASE
				AND r.pr_number = ?3 AND r.status = 'running'
			ORDER BY r.id DESC LIMIT 1
		 )`,
	)
		.bind(owner, repo, prNumber)
		.run();
}

// True when a review for this PR is running and young enough to still be
// live (older running rows are presumed dead — the /reviews stall rule).
// Backs mention-trigger dedupe so a re-tag can't double-dispatch.
export async function hasActiveReview(repositoryId: number, prNumber: number): Promise<boolean> {
	const row = await env.DB.prepare(
		`SELECT id FROM reviews
		 WHERE repository_id = ?1 AND pr_number = ?2 AND status = 'running'
			AND created_at > datetime('now', '-20 minutes')
		 LIMIT 1`,
	)
		.bind(repositoryId, prNumber)
		.first<{ id: number }>();
	return row !== null;
}

// Reviews dispatched for this installation in the last 24h (backs the daily cap).
export async function reviewCountLastDay(installationId: number): Promise<number> {
	const row = await env.DB.prepare(
		`SELECT COUNT(*) AS n FROM reviews
		 WHERE installation_id = ?1 AND created_at > datetime('now', '-1 day')`,
	)
		.bind(installationId)
		.first<{ n: number }>();
	return row?.n ?? 0;
}
