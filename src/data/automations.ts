import { sql } from 'drizzle-orm';
import type { JsonValue } from '../shared/json.ts';
import { execute, queryOne, queryRows, sqlValueList } from './database.ts';

export interface AutomationRow {
  id: number;
  organization_id: string;
  agent_id: number;
  repository_id: number | null;
  name: string;
  schedule: string;
  timezone: string;
  input_template: JsonValue;
  enabled: boolean;
  next_run_at: string | null;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
}

export async function listAutomations(organizationIds: string[]): Promise<AutomationRow[]> {
  if (organizationIds.length === 0) return [];
  return queryRows<AutomationRow>(sql`
    SELECT * FROM app.automations
    WHERE organization_id IN (${sqlValueList(organizationIds)})
    ORDER BY name, id
  `);
}

export async function getAutomation(id: number): Promise<AutomationRow | null> {
  return queryOne<AutomationRow>(sql`SELECT * FROM app.automations WHERE id = ${id}`);
}

export async function createAutomation(input: {
  organizationId: string;
  agentId: number;
  repositoryId?: number | null;
  name: string;
  schedule: string;
  timezone: string;
  inputTemplate: JsonValue;
  enabled: boolean;
  nextRunAt?: string | null;
  createdByUserId: string;
}): Promise<AutomationRow> {
  const row = await queryOne<AutomationRow>(sql`
    INSERT INTO app.automations (
      organization_id, agent_id, repository_id, name, schedule, timezone,
      input_template, enabled, next_run_at, created_by_user_id
    ) VALUES (
      ${input.organizationId}, ${input.agentId}, ${input.repositoryId ?? null}, ${input.name},
      ${input.schedule}, ${input.timezone}, ${JSON.stringify(input.inputTemplate)}::jsonb,
      ${input.enabled}, ${input.nextRunAt ?? null}, ${input.createdByUserId}
    )
    RETURNING *
  `);
  if (!row) throw new Error('automation insert returned no row');
  return row;
}

export async function updateAutomation(
  id: number,
  input: {
    agentId: number;
    repositoryId?: number | null;
    name: string;
    schedule: string;
    timezone: string;
    inputTemplate: JsonValue;
    enabled: boolean;
    nextRunAt?: string | null;
  },
): Promise<void> {
  await execute(sql`
    UPDATE app.automations SET agent_id = ${input.agentId},
      repository_id = ${input.repositoryId ?? null}, name = ${input.name},
      schedule = ${input.schedule}, timezone = ${input.timezone},
      input_template = ${JSON.stringify(input.inputTemplate)}::jsonb,
      enabled = ${input.enabled}, next_run_at = ${input.nextRunAt ?? null},
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${id}
  `);
}

export async function deleteAutomation(id: number): Promise<void> {
  await execute(sql`DELETE FROM app.automations WHERE id = ${id}`);
}

export async function listDueAutomations(now: string): Promise<AutomationRow[]> {
  return queryRows<AutomationRow>(sql`
    SELECT * FROM app.automations
    WHERE enabled AND next_run_at <= ${now}
    ORDER BY next_run_at, id
    FOR UPDATE SKIP LOCKED
  `);
}

export async function claimAutomation(
  id: number,
  expectedNextRunAt: string,
  nextRunAt: string,
): Promise<boolean> {
  const row = await queryOne<{ id: number }>(sql`
    UPDATE app.automations SET next_run_at = ${nextRunAt}, updated_at = CURRENT_TIMESTAMP
    WHERE id = ${id} AND enabled AND next_run_at = ${expectedNextRunAt}
    RETURNING id
  `);
  return row !== null;
}
