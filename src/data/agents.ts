import { sql } from 'drizzle-orm';
import { BUILTIN_AGENTS } from '../domain/agent-definitions.ts';
import { execute, queryOne, queryRows, sqlValueList, withTransaction } from './database.ts';

export interface AgentRow {
  id: number;
  organization_id: string;
  definition_key: string;
  slug: string;
  name: string;
  description: string | null;
  instructions_override: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export async function ensureBuiltinAgents(organizationId: string): Promise<void> {
  await withTransaction(async (transaction) => {
    for (const agent of BUILTIN_AGENTS) {
      await transaction.execute(sql`
        INSERT INTO app.agents (
          organization_id, definition_key, slug, name, description, instructions_override
        ) VALUES (
          ${organizationId}, ${agent.definitionKey}, ${agent.slug}, ${agent.name},
          ${agent.description}, ${agent.instructionsOverride}
        )
        ON CONFLICT(organization_id, slug) DO NOTHING
      `);
    }
  });
}

export async function listAgents(organizationIds: string[]): Promise<AgentRow[]> {
  if (organizationIds.length === 0) return [];
  return queryRows<AgentRow>(sql`
    SELECT * FROM app.agents
    WHERE organization_id IN (${sqlValueList(organizationIds)})
    ORDER BY name, id
  `);
}

export async function getAgent(id: number): Promise<AgentRow | null> {
  return queryOne<AgentRow>(sql`SELECT * FROM app.agents WHERE id = ${id}`);
}

export async function getAgentBySlug(
  organizationId: string,
  slug: string,
): Promise<AgentRow | null> {
  return queryOne<AgentRow>(sql`
    SELECT * FROM app.agents
    WHERE organization_id = ${organizationId} AND slug = ${slug}
  `);
}

export async function createAgent(input: {
  organizationId: string;
  definitionKey: string;
  slug: string;
  name: string;
  description?: string | null;
  instructionsOverride?: string | null;
}): Promise<AgentRow> {
  const row = await queryOne<AgentRow>(sql`
    INSERT INTO app.agents (
      organization_id, definition_key, slug, name, description, instructions_override
    ) VALUES (
      ${input.organizationId}, ${input.definitionKey}, ${input.slug}, ${input.name},
      ${input.description ?? null}, ${input.instructionsOverride ?? null}
    )
    RETURNING *
  `);
  if (!row) throw new Error('agent insert returned no row');
  return row;
}

export async function updateAgent(
  id: number,
  input: {
    name?: string;
    description?: string | null;
    instructionsOverride?: string | null;
    enabled?: boolean;
  },
): Promise<void> {
  await execute(sql`
    UPDATE app.agents SET
      name = COALESCE(${input.name ?? null}, name),
      description = CASE
        WHEN ${input.description === undefined} THEN description
        ELSE ${input.description ?? null}
      END,
      instructions_override = CASE
        WHEN ${input.instructionsOverride === undefined} THEN instructions_override
        ELSE ${input.instructionsOverride ?? null}
      END,
      enabled = COALESCE(${input.enabled ?? null}, enabled),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${id}
  `);
}

export async function deleteAgent(id: number): Promise<void> {
  await execute(sql`DELETE FROM app.agents WHERE id = ${id}`);
}

export async function listAgentsForRepository(repositoryId: number): Promise<AgentRow[]> {
  return queryRows<AgentRow>(sql`
    SELECT a.* FROM app.agents a
    JOIN app.repository_agents ra ON ra.agent_id = a.id
    WHERE ra.repository_id = ${repositoryId} AND a.enabled
    ORDER BY a.name, a.id
  `);
}

export async function listRepositoryAgentIds(
  repositoryIds: number[],
): Promise<Array<{ repository_id: number; agent_id: number }>> {
  if (repositoryIds.length === 0) return [];
  return queryRows(sql`
    SELECT repository_id, agent_id FROM app.repository_agents
    WHERE repository_id IN (${sqlValueList(repositoryIds)})
  `);
}

export async function setRepositoryAgent(
  repositoryId: number,
  agentId: number,
  organizationId: string,
  enabled: boolean,
): Promise<void> {
  if (enabled) {
    await execute(sql`
      INSERT INTO app.repository_agents (repository_id, agent_id, organization_id)
      VALUES (${repositoryId}, ${agentId}, ${organizationId})
      ON CONFLICT(repository_id, agent_id) DO NOTHING
    `);
    return;
  }
  await execute(sql`
    DELETE FROM app.repository_agents
    WHERE repository_id = ${repositoryId} AND agent_id = ${agentId}
  `);
}
