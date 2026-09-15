import { sql } from 'drizzle-orm';
import { execute, queryOne, queryRows, sqlValueList, withTransaction } from './postgres.ts';

export interface SkillRow {
  id: number;
  organization_id: string;
  slug: string;
  name: string;
  content: string;
  content_hash: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export async function listSkills(organizationIds: string[]): Promise<SkillRow[]> {
  if (organizationIds.length === 0) return [];
  return queryRows<SkillRow>(sql`
    SELECT * FROM app.skills
    WHERE organization_id IN (${sqlValueList(organizationIds)})
    ORDER BY name, id
  `);
}

export async function getSkill(id: number): Promise<SkillRow | null> {
  return queryOne<SkillRow>(sql`SELECT * FROM app.skills WHERE id = ${id}`);
}

export async function getSkillBySlug(
  organizationId: string,
  slug: string,
): Promise<SkillRow | null> {
  return queryOne<SkillRow>(sql`
    SELECT * FROM app.skills
    WHERE organization_id = ${organizationId} AND slug = ${slug}
  `);
}

export async function createSkill(input: {
  organizationId: string;
  slug: string;
  name: string;
  content: string;
  contentHash: string;
}): Promise<SkillRow> {
  const row = await queryOne<SkillRow>(sql`
    INSERT INTO app.skills (organization_id, slug, name, content, content_hash)
    VALUES (
      ${input.organizationId}, ${input.slug}, ${input.name}, ${input.content}, ${input.contentHash}
    )
    RETURNING *
  `);
  if (!row) throw new Error('skill insert returned no row');
  return row;
}

export async function updateSkill(
  id: number,
  input: { name?: string; content?: string; contentHash?: string; enabled?: boolean },
): Promise<void> {
  await execute(sql`
    UPDATE app.skills SET name = COALESCE(${input.name ?? null}, name),
      content = COALESCE(${input.content ?? null}, content),
      content_hash = COALESCE(${input.contentHash ?? null}, content_hash),
      enabled = COALESCE(${input.enabled ?? null}, enabled),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${id}
  `);
}

export async function deleteSkill(id: number): Promise<void> {
  await execute(sql`DELETE FROM app.skills WHERE id = ${id}`);
}

export async function listSkillsForRepository(repositoryId: number): Promise<SkillRow[]> {
  return queryRows<SkillRow>(sql`
    SELECT s.* FROM app.skills s
    JOIN app.repository_skills rs ON rs.skill_id = s.id
    WHERE rs.repository_id = ${repositoryId} AND s.enabled
    ORDER BY s.name, s.id
  `);
}

export async function listSkillsForAgent(agentId: number): Promise<SkillRow[]> {
  return queryRows<SkillRow>(sql`
    SELECT s.* FROM app.skills s
    JOIN app.agent_skills agent_skill ON agent_skill.skill_id = s.id
    WHERE agent_skill.agent_id = ${agentId} AND s.enabled
    ORDER BY s.name, s.id
  `);
}

export async function listSkillsForAutomation(automationId: number): Promise<SkillRow[]> {
  return queryRows<SkillRow>(sql`
    SELECT s.* FROM app.skills s
    JOIN app.automation_skills automation_skill ON automation_skill.skill_id = s.id
    WHERE automation_skill.automation_id = ${automationId} AND s.enabled
    ORDER BY s.name, s.id
  `);
}

export async function listRepositorySkillIds(
  repositoryIds: number[],
): Promise<Array<{ repository_id: number; skill_id: number }>> {
  if (repositoryIds.length === 0) return [];
  return queryRows(sql`
    SELECT repository_id, skill_id FROM app.repository_skills
    WHERE repository_id IN (${sqlValueList(repositoryIds)})
  `);
}

export async function setRepositorySkill(
  repositoryId: number,
  skillId: number,
  organizationId: string,
  enabled: boolean,
): Promise<void> {
  if (enabled) {
    await execute(sql`
      INSERT INTO app.repository_skills (repository_id, skill_id, organization_id)
      VALUES (${repositoryId}, ${skillId}, ${organizationId})
      ON CONFLICT(repository_id, skill_id) DO NOTHING
    `);
    return;
  }
  await execute(sql`
    DELETE FROM app.repository_skills
    WHERE repository_id = ${repositoryId} AND skill_id = ${skillId}
  `);
}

export async function listAgentSkillIds(
  agentIds: number[],
): Promise<Array<{ agent_id: number; skill_id: number }>> {
  if (agentIds.length === 0) return [];
  return queryRows(sql`
    SELECT agent_id, skill_id FROM app.agent_skills
    WHERE agent_id IN (${sqlValueList(agentIds)})
  `);
}

export async function replaceAgentSkillLinks(
  agentId: number,
  organizationId: string,
  skillIds: number[],
): Promise<void> {
  await withTransaction(async (transaction) => {
    await transaction.execute(sql`DELETE FROM app.agent_skills WHERE agent_id = ${agentId}`);
    for (const skillId of skillIds) {
      await transaction.execute(sql`
        INSERT INTO app.agent_skills (agent_id, skill_id, organization_id)
        VALUES (${agentId}, ${skillId}, ${organizationId})
      `);
    }
  });
}

export async function listAutomationSkillIds(
  automationIds: number[],
): Promise<Array<{ automation_id: number; skill_id: number }>> {
  if (automationIds.length === 0) return [];
  return queryRows(sql`
    SELECT automation_id, skill_id FROM app.automation_skills
    WHERE automation_id IN (${sqlValueList(automationIds)})
  `);
}

export async function replaceAutomationSkillLinks(
  automationId: number,
  organizationId: string,
  skillIds: number[],
): Promise<void> {
  await withTransaction(async (transaction) => {
    await transaction.execute(sql`
      DELETE FROM app.automation_skills WHERE automation_id = ${automationId}
    `);
    for (const skillId of skillIds) {
      await transaction.execute(sql`
        INSERT INTO app.automation_skills (automation_id, skill_id, organization_id)
        VALUES (${automationId}, ${skillId}, ${organizationId})
      `);
    }
  });
}
