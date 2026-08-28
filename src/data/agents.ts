import { sql } from 'drizzle-orm';
import { BUILTIN_PERSONAS, DEFAULT_AGENT_SLUG, DEFAULT_MODEL } from '../domain/personas.ts';
import { execute, queryOne, queryRows, withDatabase } from './database.ts';
import type { RepositoryRow } from './repositories.ts';
import { agents } from './schema.ts';

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
  await withDatabase(async (database) => {
    await database
      .insert(agents)
      .values(
        BUILTIN_PERSONAS.map((persona) => ({
          installationId,
          slug: persona.slug,
          name: persona.name,
          description: persona.description,
          instructions: persona.instructions,
          model: DEFAULT_MODEL,
          isBuiltin: 1,
        })),
      )
      .onConflictDoNothing({ target: [agents.installationId, agents.slug] });
  });
}

export async function listAgents(installationIds: number[]): Promise<AgentRow[]> {
  if (installationIds.length === 0) return [];
  return queryRows<AgentRow>(sql`
    SELECT * FROM app.agents
    WHERE installation_id IN (${sql.join(
      installationIds.map((id) => sql`${id}`),
      sql`, `,
    )})
    ORDER BY is_builtin DESC, name
  `);
}

export async function getAgentById(id: number): Promise<AgentRow | null> {
  return queryOne<AgentRow>(sql`SELECT * FROM app.agents WHERE id = ${id}`);
}

export async function getAgentBySlug(
  installationId: number,
  slug: string,
): Promise<AgentRow | null> {
  return queryOne<AgentRow>(sql`
    SELECT * FROM app.agents WHERE installation_id = ${installationId} AND slug = ${slug}
  `);
}

export async function createAgent(
  installationId: number,
  fields: { slug: string; name: string; description: string; instructions: string; model: string },
): Promise<void> {
  await execute(sql`
    INSERT INTO app.agents
      (installation_id, slug, name, description, instructions, model, is_builtin)
    VALUES (
      ${installationId}, ${fields.slug}, ${fields.name}, ${fields.description},
      ${fields.instructions}, ${fields.model}, 0
    )
  `);
}

export async function updateAgent(
  id: number,
  fields: { name: string; description: string; instructions: string; model: string },
): Promise<void> {
  await execute(sql`
    UPDATE app.agents SET
      name = ${fields.name}, description = ${fields.description},
      instructions = ${fields.instructions}, model = ${fields.model}
    WHERE id = ${id}
  `);
}

// Custom agents only — built-ins are permanent (they re-seed anyway).
export async function deleteAgent(id: number): Promise<void> {
  await withDatabase(async (database) => {
    await database.transaction(async (transaction) => {
      await transaction.execute(sql`DELETE FROM app.repo_agents WHERE agent_id = ${id}`);
      await transaction.execute(sql`DELETE FROM app.agents WHERE id = ${id} AND is_builtin = 0`);
    });
  });
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
  return queryRows<RepoAgentOverride>(sql`
    SELECT ra.repository_id, ra.agent_id, ra.enabled
    FROM app.repo_agents ra
    JOIN app.repositories r ON r.id = ra.repository_id
    WHERE r.installation_id IN (${sql.join(
      installationIds.map((id) => sql`${id}`),
      sql`, `,
    )})
  `);
}

export interface RepoAgentRow extends AgentRow {
  repo_enabled: number | null; // raw repo_agents.enabled; null = no row
  enabled: boolean; // resolved per agentEnabledForRepo
}

export async function listAgentsForRepo(repo: RepositoryRow): Promise<RepoAgentRow[]> {
  await ensureBuiltinAgents(repo.installation_id);
  const rows = await queryRows<AgentRow & { repo_enabled: number | null }>(sql`
    SELECT a.*, ra.enabled AS repo_enabled
    FROM app.agents a
    LEFT JOIN app.repo_agents ra ON ra.agent_id = a.id AND ra.repository_id = ${repo.id}
    WHERE a.installation_id = ${repo.installation_id}
    ORDER BY a.is_builtin DESC, a.name
  `);
  return rows.map((agent) => ({
    ...agent,
    enabled: resolveAgentEnabled(agent, agent.repo_enabled),
  }));
}

export async function setRepoAgentEnabled(
  repositoryId: number,
  agentId: number,
  enabled: boolean,
): Promise<void> {
  const changes = await execute(sql`
    INSERT INTO app.repo_agents (repository_id, agent_id, installation_id, enabled)
    SELECT r.id, a.id, r.installation_id, ${enabled ? 1 : 0}
    FROM app.repositories r
    JOIN app.agents a ON a.id = ${agentId} AND a.installation_id = r.installation_id
    WHERE r.id = ${repositoryId}
    ON CONFLICT(repository_id, agent_id) DO UPDATE SET enabled = EXCLUDED.enabled
  `);
  if (changes === 0) throw new Error('repository and agent must belong to one tenant');
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
  return queryRows<SkillRow>(sql`
    SELECT * FROM app.skills
    WHERE installation_id IN (${sql.join(
      installationIds.map((id) => sql`${id}`),
      sql`, `,
    )})
    ORDER BY name
  `);
}

export async function getSkillById(id: number): Promise<SkillRow | null> {
  return queryOne<SkillRow>(sql`SELECT * FROM app.skills WHERE id = ${id}`);
}

export async function getSkillBySlug(
  installationId: number,
  slug: string,
): Promise<SkillRow | null> {
  return queryOne<SkillRow>(sql`
    SELECT * FROM app.skills WHERE installation_id = ${installationId} AND slug = ${slug}
  `);
}

export async function createSkill(
  installationId: number,
  fields: { slug: string; name: string; description: string; instructions: string },
): Promise<void> {
  await execute(sql`
    INSERT INTO app.skills (installation_id, slug, name, description, instructions)
    VALUES (
      ${installationId}, ${fields.slug}, ${fields.name},
      ${fields.description}, ${fields.instructions}
    )
  `);
}

export async function updateSkill(
  id: number,
  fields: { name: string; description: string; instructions: string },
): Promise<void> {
  await execute(sql`
    UPDATE app.skills SET
      name = ${fields.name}, description = ${fields.description},
      instructions = ${fields.instructions}
    WHERE id = ${id}
  `);
}

export async function deleteSkill(id: number): Promise<void> {
  await withDatabase(async (database) => {
    await database.transaction(async (transaction) => {
      await transaction.execute(sql`DELETE FROM app.repo_skills WHERE skill_id = ${id}`);
      await transaction.execute(sql`DELETE FROM app.skills WHERE id = ${id}`);
    });
  });
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
  return queryRows<RepoSkillOverride>(sql`
    SELECT rs.repository_id, rs.skill_id, rs.enabled
    FROM app.repo_skills rs
    JOIN app.repositories r ON r.id = rs.repository_id
    WHERE r.installation_id IN (${sql.join(
      installationIds.map((id) => sql`${id}`),
      sql`, `,
    )})
  `);
}

export async function setRepoSkillEnabled(
  repositoryId: number,
  skillId: number,
  enabled: boolean,
): Promise<void> {
  const changes = await execute(sql`
    INSERT INTO app.repo_skills (repository_id, skill_id, installation_id, enabled)
    SELECT r.id, s.id, r.installation_id, ${enabled ? 1 : 0}
    FROM app.repositories r
    JOIN app.skills s ON s.id = ${skillId} AND s.installation_id = r.installation_id
    WHERE r.id = ${repositoryId}
    ON CONFLICT(repository_id, skill_id) DO UPDATE SET enabled = EXCLUDED.enabled
  `);
  if (changes === 0) throw new Error('repository and skill must belong to one tenant');
}

export async function listEnabledSkillsForRepo(repositoryId: number): Promise<SkillRow[]> {
  return queryRows<SkillRow>(sql`
    SELECT s.* FROM app.skills s
    JOIN app.repo_skills rs ON rs.skill_id = s.id
    WHERE rs.repository_id = ${repositoryId} AND rs.enabled = 1
    ORDER BY s.name
  `);
}
