import { database } from './postgres.ts';
import { placeholderList } from './sql.ts';
import { BUILTIN_PERSONAS, DEFAULT_AGENT_SLUG, DEFAULT_MODEL } from '../domain/personas.ts';
import type { RepositoryRow } from './repositories.ts';

// --- Custom agents (design in docs/custom-agents-design.md) ---

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
  await database().batch(
    BUILTIN_PERSONAS.map((p) =>
      database()
        .prepare(
          `INSERT INTO agents (installation_id, slug, name, description, instructions, model, is_builtin)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1)
				 ON CONFLICT(installation_id, slug) DO NOTHING`,
        )
        .bind(installationId, p.slug, p.name, p.description, p.instructions, DEFAULT_MODEL),
    ),
  );
}

export async function listAgents(installationIds: number[]): Promise<AgentRow[]> {
  if (installationIds.length === 0) return [];
  const placeholders = placeholderList(installationIds.length);
  const res = await database()
    .prepare(
      `SELECT * FROM agents WHERE installation_id IN (${placeholders})
		 ORDER BY is_builtin DESC, name`,
    )
    .bind(...installationIds)
    .all<AgentRow>();
  return res.results;
}

export async function getAgentById(id: number): Promise<AgentRow | null> {
  return database().prepare('SELECT * FROM agents WHERE id = ?1').bind(id).first<AgentRow>();
}

export async function getAgentBySlug(
  installationId: number,
  slug: string,
): Promise<AgentRow | null> {
  return database()
    .prepare('SELECT * FROM agents WHERE installation_id = ?1 AND slug = ?2')
    .bind(installationId, slug)
    .first<AgentRow>();
}

export async function createAgent(
  installationId: number,
  fields: { slug: string; name: string; description: string; instructions: string; model: string },
): Promise<void> {
  await database()
    .prepare(
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
  await database()
    .prepare(
      'UPDATE agents SET name = ?2, description = ?3, instructions = ?4, model = ?5 WHERE id = ?1',
    )
    .bind(id, fields.name, fields.description, fields.instructions, fields.model)
    .run();
}

// Custom agents only — built-ins are permanent (they re-seed anyway).
export async function deleteAgent(id: number): Promise<void> {
  await database().batch([
    database().prepare('DELETE FROM repo_agents WHERE agent_id = ?1').bind(id),
    database().prepare('DELETE FROM agents WHERE id = ?1 AND is_builtin = 0').bind(id),
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
  const placeholders = placeholderList(installationIds.length);
  const res = await database()
    .prepare(
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
  const res = await database()
    .prepare(
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
  const result = await database()
    .prepare(
      `INSERT INTO repo_agents (repository_id, agent_id, installation_id, enabled)
		 SELECT r.id, a.id, r.installation_id, ?3
		 FROM repositories r
		 JOIN agents a ON a.id = ?2 AND a.installation_id = r.installation_id
		 WHERE r.id = ?1
		 ON CONFLICT(repository_id, agent_id) DO UPDATE SET enabled = EXCLUDED.enabled`,
    )
    .bind(repositoryId, agentId, enabled ? 1 : 0)
    .run();
  if (result.meta.changes === 0) throw new Error('repository and agent must belong to one tenant');
}

// --- Skills ---

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
  const placeholders = placeholderList(installationIds.length);
  const res = await database()
    .prepare(
      `SELECT * FROM skills WHERE installation_id IN (${placeholders})
		 ORDER BY name`,
    )
    .bind(...installationIds)
    .all<SkillRow>();
  return res.results;
}

export async function getSkillById(id: number): Promise<SkillRow | null> {
  return database().prepare('SELECT * FROM skills WHERE id = ?1').bind(id).first<SkillRow>();
}

export async function getSkillBySlug(
  installationId: number,
  slug: string,
): Promise<SkillRow | null> {
  return database()
    .prepare('SELECT * FROM skills WHERE installation_id = ?1 AND slug = ?2')
    .bind(installationId, slug)
    .first<SkillRow>();
}

export async function createSkill(
  installationId: number,
  fields: { slug: string; name: string; description: string; instructions: string },
): Promise<void> {
  await database()
    .prepare(
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
  await database()
    .prepare('UPDATE skills SET name = ?2, description = ?3, instructions = ?4 WHERE id = ?1')
    .bind(id, fields.name, fields.description, fields.instructions)
    .run();
}

export async function deleteSkill(id: number): Promise<void> {
  await database().batch([
    database().prepare('DELETE FROM repo_skills WHERE skill_id = ?1').bind(id),
    database().prepare('DELETE FROM skills WHERE id = ?1').bind(id),
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
  const placeholders = placeholderList(installationIds.length);
  const res = await database()
    .prepare(
      `SELECT rs.repository_id, rs.skill_id, rs.enabled
		 FROM repo_skills rs
		 JOIN repositories r ON r.id = rs.repository_id
		 WHERE r.installation_id IN (${placeholders})`,
    )
    .bind(...installationIds)
    .all<RepoSkillOverride>();
  return res.results;
}

export async function setRepoSkillEnabled(
  repositoryId: number,
  skillId: number,
  enabled: boolean,
): Promise<void> {
  const result = await database()
    .prepare(
      `INSERT INTO repo_skills (repository_id, skill_id, installation_id, enabled)
		 SELECT r.id, s.id, r.installation_id, ?3
		 FROM repositories r
		 JOIN skills s ON s.id = ?2 AND s.installation_id = r.installation_id
		 WHERE r.id = ?1
		 ON CONFLICT(repository_id, skill_id) DO UPDATE SET enabled = EXCLUDED.enabled`,
    )
    .bind(repositoryId, skillId, enabled ? 1 : 0)
    .run();
  if (result.meta.changes === 0) throw new Error('repository and skill must belong to one tenant');
}

export async function listEnabledSkillsForRepo(repositoryId: number): Promise<SkillRow[]> {
  const res = await database()
    .prepare(
      `SELECT s.* FROM skills s
		 JOIN repo_skills rs ON rs.skill_id = s.id
		 WHERE rs.repository_id = ?1 AND rs.enabled = 1
		 ORDER BY s.name`,
    )
    .bind(repositoryId)
    .all<SkillRow>();
  return res.results;
}
