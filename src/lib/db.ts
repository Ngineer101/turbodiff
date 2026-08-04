import { env } from 'cloudflare:workers';
import { openToken } from './crypto.ts';
import { BUILTIN_PERSONAS, DEFAULT_AGENT_SLUG, DEFAULT_MODEL } from './personas.ts';

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
	agentSlug: string,
	agentInstanceId: string,
	riskTier: string | null = null,
): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO reviews (repository_id, installation_id, pr_number, trigger_event, status, agent_slug, agent_instance_id, risk_tier)
		 VALUES (?1, ?2, ?3, ?4, 'running', ?5, ?6, ?7)`,
	)
		.bind(repositoryId, installationId, prNumber, trigger, agentSlug, agentInstanceId, riskTier)
		.run();
}

// Called by the post_review tool once the agent has published to GitHub.
// Keyed by the exact agent instance so concurrent agents reviewing the same
// PR can never complete each other's rows.
export async function completeReview(
	agentInstanceId: string,
	reviewUrl: string | null,
	findingsCount: number | null = null,
): Promise<void> {
	await env.DB.prepare(
		`UPDATE reviews
		 SET status = 'completed', completed_at = datetime('now'), review_url = ?2, findings_count = ?3
		 WHERE id = (
			SELECT id FROM reviews
			WHERE agent_instance_id = ?1 AND status = 'running'
			ORDER BY id DESC LIMIT 1
		 )`,
	)
		.bind(agentInstanceId, reviewUrl, findingsCount)
		.run();
}

// Accumulates one model turn's usage onto the latest review row for an agent
// instance. Fired from the observe() metering subscriber.
export async function addReviewUsage(
	agentInstanceId: string,
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
			input_tokens = input_tokens + ?2,
			output_tokens = output_tokens + ?3,
			cache_read_tokens = cache_read_tokens + ?4,
			cache_write_tokens = cache_write_tokens + ?5,
			cost_usd = cost_usd + ?6,
			model = ?7
		 WHERE id = (
			SELECT id FROM reviews WHERE agent_instance_id = ?1
			ORDER BY id DESC LIMIT 1
		 )`,
	)
		.bind(
			agentInstanceId,
			usage.inputTokens,
			usage.outputTokens,
			usage.cacheReadTokens,
			usage.cacheWriteTokens,
			usage.costUsd,
			usage.model,
		)
		.run();
}

// --- Custom agents (migration 0004; design in docs/custom-agents-design.md) ---

export interface AgentRow {
	id: number;
	installation_id: number;
	slug: string;
	name: string;
	description: string | null;
	instructions: string;
	model: string;
	is_builtin: number;
	created_at: string;
}

// Lazily seeds the built-in personas for an installation. Idempotent: the
// UNIQUE(installation_id, slug) constraint makes re-runs no-ops, and users'
// edits to seeded rows are never overwritten.
export async function ensureBuiltinAgents(installationId: number): Promise<void> {
	await env.DB.batch(
		BUILTIN_PERSONAS.map((p) =>
			env.DB.prepare(
				`INSERT INTO agents (installation_id, slug, name, description, instructions, model, is_builtin)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1)
				 ON CONFLICT(installation_id, slug) DO NOTHING`,
			).bind(installationId, p.slug, p.name, p.description, p.instructions, DEFAULT_MODEL),
		),
	);
}

export async function listAgents(installationIds: number[]): Promise<AgentRow[]> {
	if (installationIds.length === 0) return [];
	const placeholders = installationIds.map((_, i) => `?${i + 1}`).join(', ');
	const res = await env.DB.prepare(
		`SELECT * FROM agents WHERE installation_id IN (${placeholders})
		 ORDER BY is_builtin DESC, name`,
	)
		.bind(...installationIds)
		.all<AgentRow>();
	return res.results;
}

export async function getAgentById(id: number): Promise<AgentRow | null> {
	return env.DB.prepare('SELECT * FROM agents WHERE id = ?1').bind(id).first<AgentRow>();
}

export async function getAgentBySlug(
	installationId: number,
	slug: string,
): Promise<AgentRow | null> {
	return env.DB.prepare('SELECT * FROM agents WHERE installation_id = ?1 AND slug = ?2')
		.bind(installationId, slug)
		.first<AgentRow>();
}

export async function createAgent(
	installationId: number,
	fields: { slug: string; name: string; description: string; instructions: string; model: string },
): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO agents (installation_id, slug, name, description, instructions, model, is_builtin)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)`,
	)
		.bind(installationId, fields.slug, fields.name, fields.description, fields.instructions, fields.model)
		.run();
}

export async function updateAgent(
	id: number,
	fields: { name: string; description: string; instructions: string; model: string },
): Promise<void> {
	await env.DB.prepare(
		'UPDATE agents SET name = ?2, description = ?3, instructions = ?4, model = ?5 WHERE id = ?1',
	)
		.bind(id, fields.name, fields.description, fields.instructions, fields.model)
		.run();
}

// Custom agents only — built-ins are permanent (they re-seed anyway).
export async function deleteAgent(id: number): Promise<void> {
	await env.DB.batch([
		env.DB.prepare('DELETE FROM repo_agents WHERE agent_id = ?1').bind(id),
		env.DB.prepare('DELETE FROM agent_connections WHERE agent_id = ?1').bind(id),
		env.DB.prepare('DELETE FROM agents WHERE id = ?1 AND is_builtin = 0').bind(id),
	]);
}

// Enablement semantics: an explicit repo_agents row wins; with no row, the
// built-in 'review' agent defaults on (preserving single-agent behavior) and
// everything else defaults off.
export function resolveAgentEnabled(
	agent: AgentRow,
	override: number | null | undefined,
): boolean {
	if (override !== null && override !== undefined) return override === 1;
	return agent.is_builtin === 1 && agent.slug === DEFAULT_AGENT_SLUG;
}

export interface RepoAgentOverride {
	repository_id: number;
	agent_id: number;
	enabled: number;
}

// All explicit repo × agent overrides for these installations, for UIs that
// render many repos at once without a per-repo query.
export async function listRepoAgentOverrides(
	installationIds: number[],
): Promise<RepoAgentOverride[]> {
	if (installationIds.length === 0) return [];
	const placeholders = installationIds.map((_, i) => `?${i + 1}`).join(', ');
	const res = await env.DB.prepare(
		`SELECT ra.repository_id, ra.agent_id, ra.enabled
		 FROM repo_agents ra
		 JOIN repositories r ON r.id = ra.repository_id
		 WHERE r.installation_id IN (${placeholders})`,
	)
		.bind(...installationIds)
		.all<RepoAgentOverride>();
	return res.results;
}

export interface RepoAgentRow extends AgentRow {
	repo_enabled: number | null; // raw repo_agents.enabled; null = no row
	enabled: boolean; // resolved per agentEnabledForRepo
}

export async function listAgentsForRepo(repo: RepositoryRow): Promise<RepoAgentRow[]> {
	await ensureBuiltinAgents(repo.installation_id);
	const res = await env.DB.prepare(
		`SELECT a.*, ra.enabled AS repo_enabled
		 FROM agents a
		 LEFT JOIN repo_agents ra ON ra.agent_id = a.id AND ra.repository_id = ?2
		 WHERE a.installation_id = ?1
		 ORDER BY a.is_builtin DESC, a.name`,
	)
		.bind(repo.installation_id, repo.id)
		.all<AgentRow & { repo_enabled: number | null }>();
	return res.results.map((a) => ({ ...a, enabled: resolveAgentEnabled(a, a.repo_enabled) }));
}

export async function setRepoAgentEnabled(
	repositoryId: number,
	agentId: number,
	enabled: boolean,
): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO repo_agents (repository_id, agent_id, enabled) VALUES (?1, ?2, ?3)
		 ON CONFLICT(repository_id, agent_id) DO UPDATE SET enabled = ?3`,
	)
		.bind(repositoryId, agentId, enabled ? 1 : 0)
		.run();
}

// --- External MCP tool connections per agent (migration 0005) ---

export interface AgentConnectionRow {
	id: number;
	agent_id: number;
	name: string;
	url: string;
	tool_allowlist: string | null; // JSON string array; null = all tools
	auth_ciphertext: string | null;
	optional: number;
	created_at: string;
}

// The non-secret snapshot that rides the review.request signal so the agent
// render can mount connections. The bearer token never leaves D1: the auth
// resolver fetches and decrypts it by connection id at request time.
export interface ConnectionSnapshot {
	id: number;
	name: string;
	url: string;
	tools?: string[];
	hasAuth: boolean;
	optional: boolean;
}

export function connectionSnapshot(row: AgentConnectionRow): ConnectionSnapshot {
	let tools: string[] | undefined;
	if (row.tool_allowlist) {
		try {
			const parsed = JSON.parse(row.tool_allowlist);
			if (Array.isArray(parsed) && parsed.length > 0) tools = parsed.map(String);
		} catch {
			// Malformed allowlist behaves as "all tools" rather than failing runs.
		}
	}
	return {
		id: row.id,
		name: row.name,
		url: row.url,
		...(tools ? { tools } : {}),
		hasAuth: row.auth_ciphertext !== null,
		optional: row.optional === 1,
	};
}

export async function listAgentConnections(agentId: number): Promise<AgentConnectionRow[]> {
	const res = await env.DB.prepare(
		'SELECT * FROM agent_connections WHERE agent_id = ?1 ORDER BY name',
	)
		.bind(agentId)
		.all<AgentConnectionRow>();
	return res.results;
}

export async function getAgentConnection(id: number): Promise<AgentConnectionRow | null> {
	return env.DB.prepare('SELECT * FROM agent_connections WHERE id = ?1')
		.bind(id)
		.first<AgentConnectionRow>();
}

export async function createAgentConnection(
	agentId: number,
	fields: {
		name: string;
		url: string;
		toolAllowlist: string[] | null;
		authCiphertext: string | null;
		optional: boolean;
	},
): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO agent_connections (agent_id, name, url, tool_allowlist, auth_ciphertext, optional)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
	)
		.bind(
			agentId,
			fields.name,
			fields.url,
			fields.toolAllowlist ? JSON.stringify(fields.toolAllowlist) : null,
			fields.authCiphertext,
			fields.optional ? 1 : 0,
		)
		.run();
}

export async function deleteAgentConnection(id: number): Promise<void> {
	await env.DB.prepare('DELETE FROM agent_connections WHERE id = ?1').bind(id).run();
}

// The MCP auth resolver: called by the Flue transport on every request to an
// authenticated server. Fetches and unseals the token on demand — it never
// lands in the conversation, the signal, or the UI.
export async function getConnectionAuthToken(connectionId: number): Promise<string> {
	const row = await getAgentConnection(connectionId);
	if (!row?.auth_ciphertext) {
		throw new Error(`turbodiff: connection ${connectionId} has no stored token`);
	}
	return openToken(row.auth_ciphertext);
}

export interface AgentUsageRow {
	agent_slug: string | null;
	reviews: number;
	cost_usd: number;
}

// Cost per agent for one 'YYYY-MM' month, costliest first. NULL slug groups
// reviews recorded before multi-agent support.
export async function agentUsageForMonth(
	installationIds: number[],
	month: string,
): Promise<AgentUsageRow[]> {
	if (installationIds.length === 0) return [];
	const placeholders = installationIds.map((_, i) => `?${i + 1}`).join(', ');
	const res = await env.DB.prepare(
		`SELECT agent_slug, COUNT(*) AS reviews, SUM(cost_usd) AS cost_usd
		 FROM reviews
		 WHERE installation_id IN (${placeholders})
			AND strftime('%Y-%m', created_at) = ?${installationIds.length + 1}
		 GROUP BY agent_slug
		 ORDER BY cost_usd DESC`,
	)
		.bind(...installationIds, month)
		.all<AgentUsageRow>();
	return res.results;
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
	agent_slug: string | null; // null on rows predating multi-agent support
	agent_instance_id: string | null;
	risk_tier: string | null; // null before tiering, and on mention/manual dispatch
	findings_count: number | null; // null until post_review completes the row
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
	avg_findings: number | null; // findings per completed review this month
	running: number;
}

export async function dashboardStats(installationIds: number[]): Promise<DashboardStats> {
	const empty: DashboardStats = {
		month_reviews: 0,
		month_cost_usd: 0,
		month_tokens: 0,
		avg_duration_s: null,
		avg_findings: null,
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
			AVG(CASE WHEN status = 'completed' AND findings_count IS NOT NULL
				AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
				THEN findings_count END) AS avg_findings,
			COALESCE(SUM(status = 'running'), 0) AS running
		 FROM reviews
		 WHERE installation_id IN (${placeholders})`,
	)
		.bind(...installationIds)
		.first<DashboardStats>();
	return row ?? empty;
}

// Marks the latest still-running review for an agent instance as failed.
// Fired from the metering subscriber when the agent's submission settles
// without post_review having completed the row (agent error, abort, or a run
// that never posted). No-op when the row is already completed.
export async function markReviewFailed(agentInstanceId: string): Promise<void> {
	await env.DB.prepare(
		`UPDATE reviews SET status = 'failed', completed_at = datetime('now')
		 WHERE id = (
			SELECT id FROM reviews WHERE agent_instance_id = ?1 AND status = 'running'
			ORDER BY id DESC LIMIT 1
		 )`,
	)
		.bind(agentInstanceId)
		.run();
}

// True when this agent's review of this PR is running and young enough to
// still be live (older running rows are presumed dead — the /reviews stall
// rule). Backs mention-trigger dedupe so a re-tag can't double-dispatch.
export async function hasActiveReview(
	repositoryId: number,
	prNumber: number,
	agentSlug: string,
): Promise<boolean> {
	const row = await env.DB.prepare(
		`SELECT id FROM reviews
		 WHERE repository_id = ?1 AND pr_number = ?2 AND agent_slug = ?3
			AND status = 'running' AND created_at > datetime('now', '-20 minutes')
		 LIMIT 1`,
	)
		.bind(repositoryId, prNumber, agentSlug)
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
