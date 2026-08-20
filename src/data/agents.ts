import { env } from 'cloudflare:workers';
import { BUILTIN_PERSONAS, DEFAULT_AGENT_SLUG, DEFAULT_MODEL } from '../domain/personas.ts';
import type { RepositoryRow } from './repositories.ts';

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
    .bind(
      installationId,
      fields.slug,
      fields.name,
      fields.description,
      fields.instructions,
      fields.model,
    )
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
export function resolveAgentEnabled(agent: AgentRow, override: number | null | undefined): boolean {
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

// --- Skills (migration 0025) ---

export interface SkillRow {
  id: number;
  installation_id: number;
  slug: string;
  name: string;
  description: string | null;
  instructions: string;
  created_at: string;
}

export async function listSkills(installationIds: number[]): Promise<SkillRow[]> {
  if (installationIds.length === 0) return [];
  const placeholders = installationIds.map((_, i) => `?${i + 1}`).join(', ');
  const res = await env.DB.prepare(
    `SELECT * FROM skills WHERE installation_id IN (${placeholders})
		 ORDER BY name`,
  )
    .bind(...installationIds)
    .all<SkillRow>();
  return res.results;
}

export async function getSkillById(id: number): Promise<SkillRow | null> {
  return env.DB.prepare('SELECT * FROM skills WHERE id = ?1').bind(id).first<SkillRow>();
}

export async function getSkillBySlug(
  installationId: number,
  slug: string,
): Promise<SkillRow | null> {
  return env.DB.prepare('SELECT * FROM skills WHERE installation_id = ?1 AND slug = ?2')
    .bind(installationId, slug)
    .first<SkillRow>();
}

export async function createSkill(
  installationId: number,
  fields: { slug: string; name: string; description: string; instructions: string },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO skills (installation_id, slug, name, description, instructions)
		 VALUES (?1, ?2, ?3, ?4, ?5)`,
  )
    .bind(installationId, fields.slug, fields.name, fields.description, fields.instructions)
    .run();
}

export async function updateSkill(
  id: number,
  fields: { name: string; description: string; instructions: string },
): Promise<void> {
  await env.DB.prepare(
    'UPDATE skills SET name = ?2, description = ?3, instructions = ?4 WHERE id = ?1',
  )
    .bind(id, fields.name, fields.description, fields.instructions)
    .run();
}

export async function deleteSkill(id: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM repo_skills WHERE skill_id = ?1').bind(id),
    env.DB.prepare('DELETE FROM skills WHERE id = ?1').bind(id),
  ]);
}

// Enablement semantics: no built-in default (unlike agents) — a skill is
// enabled for a repo only via an explicit repo_skills row.
export function resolveSkillEnabled(override: number | null | undefined): boolean {
  return override === 1;
}

export interface RepoSkillOverride {
  repository_id: number;
  skill_id: number;
  enabled: number;
}

// All explicit repo × skill overrides for these installations, for UIs that
// render many repos at once without a per-repo query.
export async function listRepoSkillOverrides(
  installationIds: number[],
): Promise<RepoSkillOverride[]> {
  if (installationIds.length === 0) return [];
  const placeholders = installationIds.map((_, i) => `?${i + 1}`).join(', ');
  const res = await env.DB.prepare(
    `SELECT rs.repository_id, rs.skill_id, rs.enabled
		 FROM repo_skills rs
		 JOIN repositories r ON r.id = rs.repository_id
		 WHERE r.installation_id IN (${placeholders})`,
  )
    .bind(...installationIds)
    .all<RepoSkillOverride>();
  return res.results;
}

export interface RepoSkillRow extends SkillRow {
  repo_enabled: number | null; // raw repo_skills.enabled; null = no row
  enabled: boolean; // resolved per resolveSkillEnabled
}

export async function listSkillsForRepo(repo: RepositoryRow): Promise<RepoSkillRow[]> {
  const res = await env.DB.prepare(
    `SELECT s.*, rs.enabled AS repo_enabled
		 FROM skills s
		 LEFT JOIN repo_skills rs ON rs.skill_id = s.id AND rs.repository_id = ?2
		 WHERE s.installation_id = ?1
		 ORDER BY s.name`,
  )
    .bind(repo.installation_id, repo.id)
    .all<SkillRow & { repo_enabled: number | null }>();
  return res.results.map((s) => ({ ...s, enabled: resolveSkillEnabled(s.repo_enabled) }));
}

export async function setRepoSkillEnabled(
  repositoryId: number,
  skillId: number,
  enabled: boolean,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO repo_skills (repository_id, skill_id, enabled) VALUES (?1, ?2, ?3)
		 ON CONFLICT(repository_id, skill_id) DO UPDATE SET enabled = ?3`,
  )
    .bind(repositoryId, skillId, enabled ? 1 : 0)
    .run();
}

export async function listEnabledSkillsForRepo(repositoryId: number): Promise<SkillRow[]> {
  const res = await env.DB.prepare(
    `SELECT s.* FROM skills s
		 JOIN repo_skills rs ON rs.skill_id = s.id
		 WHERE rs.repository_id = ?1 AND rs.enabled = 1
		 ORDER BY s.name`,
  )
    .bind(repositoryId)
    .all<SkillRow>();
  return res.results;
}
