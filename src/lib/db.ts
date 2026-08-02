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
		`INSERT INTO reviews (repository_id, installation_id, pr_number, trigger_event)
		 VALUES (?1, ?2, ?3, ?4)`,
	)
		.bind(repositoryId, installationId, prNumber, trigger)
		.run();
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
