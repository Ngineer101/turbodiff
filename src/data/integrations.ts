import { sql } from 'drizzle-orm';
import type { JsonValue } from '../shared/json.ts';
import { execute, queryOne, queryRows, sqlValueList, withTransaction } from './postgres.ts';

export interface IntegrationRow {
  id: number;
  organization_id: string;
  kind: 'scm' | 'artifact_store' | 'mcp' | 'api';
  provider: string;
  name: string;
  external_account_id: string | null;
  config: JsonValue;
  auth_ciphertext: string | null;
  auth_expires_at: string | null;
  needs_reauthorization: boolean;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export async function listIntegrations(organizationIds: string[]): Promise<IntegrationRow[]> {
  if (organizationIds.length === 0) return [];
  return queryRows<IntegrationRow>(sql`
    SELECT * FROM app.integrations
    WHERE organization_id IN (${sqlValueList(organizationIds)})
    ORDER BY name, id
  `);
}

export async function hasEnabledGithubIntegration(organizationIds: string[]): Promise<boolean> {
  if (organizationIds.length === 0) return false;
  const row = await queryOne<{ connected: boolean }>(sql`
    SELECT EXISTS(
      SELECT 1 FROM app.integrations
      WHERE organization_id IN (${sqlValueList(organizationIds)})
        AND kind = 'scm' AND provider = 'github' AND enabled
    ) AS connected
  `);
  return row?.connected ?? false;
}

export async function getIntegration(id: number): Promise<IntegrationRow | null> {
  return queryOne<IntegrationRow>(sql`SELECT * FROM app.integrations WHERE id = ${id}`);
}

export async function getIntegrationByExternalAccount(
  provider: string,
  externalAccountId: string,
): Promise<IntegrationRow | null> {
  return queryOne<IntegrationRow>(sql`
    SELECT * FROM app.integrations
    WHERE provider = ${provider} AND external_account_id = ${externalAccountId}
    ORDER BY id
    LIMIT 1
  `);
}

export async function createIntegration(input: {
  organizationId: string;
  kind: IntegrationRow['kind'];
  provider: string;
  name: string;
  externalAccountId?: string | null;
  config?: JsonValue;
  authCiphertext?: string | null;
}): Promise<IntegrationRow> {
  const row = await queryOne<IntegrationRow>(sql`
    INSERT INTO app.integrations (
      organization_id, kind, provider, name, external_account_id, config, auth_ciphertext
    ) VALUES (
      ${input.organizationId}, ${input.kind}, ${input.provider}, ${input.name},
      ${input.externalAccountId ?? null}, ${JSON.stringify(input.config ?? {})}::jsonb,
      ${input.authCiphertext ?? null}
    )
    RETURNING *
  `);
  if (!row) throw new Error('integration insert returned no row');
  return row;
}

export async function upsertExternalIntegration(input: {
  organizationId: string;
  kind: IntegrationRow['kind'];
  provider: string;
  name: string;
  externalAccountId: string;
  config: JsonValue;
  enabled?: boolean;
}): Promise<IntegrationRow> {
  const row = await queryOne<IntegrationRow>(sql`
    INSERT INTO app.integrations (
      organization_id, kind, provider, name, external_account_id, config, enabled
    ) VALUES (
      ${input.organizationId}, ${input.kind}, ${input.provider}, ${input.name},
      ${input.externalAccountId}, ${JSON.stringify(input.config)}::jsonb,
      ${input.enabled ?? true}
    )
    ON CONFLICT(provider, external_account_id) WHERE external_account_id IS NOT NULL
    DO UPDATE SET name = excluded.name, config = excluded.config, enabled = excluded.enabled,
      updated_at = CURRENT_TIMESTAMP
    RETURNING *
  `);
  if (!row) throw new Error('integration upsert returned no row');
  return row;
}

export async function updateIntegration(
  id: number,
  input: { name: string; config: JsonValue; enabled: boolean },
): Promise<void> {
  await execute(sql`
    UPDATE app.integrations SET
      name = ${input.name}, config = ${JSON.stringify(input.config)}::jsonb,
      enabled = ${input.enabled}, updated_at = CURRENT_TIMESTAMP
    WHERE id = ${id}
  `);
}

export async function updateIntegrationAuth(
  id: number,
  authCiphertext: string | null,
  expiresAt: string | null,
  needsReauthorization: boolean,
): Promise<void> {
  await execute(sql`
    UPDATE app.integrations SET
      auth_ciphertext = ${authCiphertext}, auth_expires_at = ${expiresAt},
      needs_reauthorization = ${needsReauthorization}, updated_at = CURRENT_TIMESTAMP
    WHERE id = ${id}
  `);
}

export async function tryClaimIntegrationAuthRefresh(
  id: number,
  expectedExpiresAt: string | null,
  claimUntil: string,
): Promise<boolean> {
  const changes = await execute(sql`
    UPDATE app.integrations SET auth_expires_at = ${claimUntil}, updated_at = CURRENT_TIMESTAMP
    WHERE id = ${id}
      AND auth_expires_at IS NOT DISTINCT FROM ${expectedExpiresAt}::timestamptz
  `);
  return changes > 0;
}

export async function deleteIntegration(id: number): Promise<void> {
  await execute(sql`DELETE FROM app.integrations WHERE id = ${id}`);
}

export async function replaceRepositoryIntegrationLinks(
  repositoryId: number,
  organizationId: string,
  integrationIds: number[],
): Promise<void> {
  await withTransaction(async (transaction) => {
    await transaction.execute(sql`
      DELETE FROM app.repository_integrations WHERE repository_id = ${repositoryId}
    `);
    for (const integrationId of integrationIds) {
      await transaction.execute(sql`
        INSERT INTO app.repository_integrations
          (repository_id, integration_id, organization_id)
        VALUES (${repositoryId}, ${integrationId}, ${organizationId})
      `);
    }
  });
}

export async function listRepositoryIntegrationIds(
  repositoryIds: number[],
): Promise<Array<{ repository_id: number; integration_id: number }>> {
  if (repositoryIds.length === 0) return [];
  return queryRows(sql`
    SELECT repository_id, integration_id FROM app.repository_integrations
    WHERE repository_id IN (${sqlValueList(repositoryIds)})
  `);
}

export async function setRepositoryIntegration(
  repositoryId: number,
  integrationId: number,
  organizationId: string,
  enabled: boolean,
): Promise<void> {
  if (enabled) {
    await execute(sql`
      INSERT INTO app.repository_integrations (repository_id, integration_id, organization_id)
      VALUES (${repositoryId}, ${integrationId}, ${organizationId})
      ON CONFLICT(repository_id, integration_id) DO NOTHING
    `);
    return;
  }
  await execute(sql`
    DELETE FROM app.repository_integrations
    WHERE repository_id = ${repositoryId} AND integration_id = ${integrationId}
  `);
}

export async function repositoryHasIntegration(
  repositoryId: number,
  integrationId: number,
): Promise<boolean> {
  const row = await queryOne<{ linked: boolean }>(sql`
    SELECT EXISTS(
      SELECT 1 FROM app.repository_integrations
      WHERE repository_id = ${repositoryId} AND integration_id = ${integrationId}
    ) AS linked
  `);
  return row?.linked ?? false;
}

export async function automationHasIntegration(
  automationId: number,
  integrationId: number,
): Promise<boolean> {
  const row = await queryOne<{ linked: boolean }>(sql`
    SELECT EXISTS(
      SELECT 1 FROM app.automation_integrations
      WHERE automation_id = ${automationId} AND integration_id = ${integrationId}
    ) AS linked
  `);
  return row?.linked ?? false;
}

export async function listAutomationIntegrationIds(
  automationIds: number[],
): Promise<Array<{ automation_id: number; integration_id: number }>> {
  if (automationIds.length === 0) return [];
  return queryRows(sql`
    SELECT automation_id, integration_id FROM app.automation_integrations
    WHERE automation_id IN (${sqlValueList(automationIds)})
  `);
}

export async function replaceAutomationIntegrationLinks(
  automationId: number,
  organizationId: string,
  integrationIds: number[],
): Promise<void> {
  await withTransaction(async (transaction) => {
    await transaction.execute(sql`
      DELETE FROM app.automation_integrations WHERE automation_id = ${automationId}
    `);
    for (const integrationId of integrationIds) {
      await transaction.execute(sql`
        INSERT INTO app.automation_integrations (automation_id, integration_id, organization_id)
        VALUES (${automationId}, ${integrationId}, ${organizationId})
      `);
    }
  });
}

export async function listRepositoryIntegrations(repositoryId: number): Promise<IntegrationRow[]> {
  return queryRows<IntegrationRow>(sql`
    SELECT i.* FROM app.integrations i
    JOIN app.repository_integrations ri ON ri.integration_id = i.id
    WHERE ri.repository_id = ${repositoryId} AND i.enabled
    ORDER BY i.name, i.id
  `);
}

export async function listAutomationIntegrations(automationId: number): Promise<IntegrationRow[]> {
  return queryRows<IntegrationRow>(sql`
    SELECT i.* FROM app.integrations i
    JOIN app.automation_integrations ai ON ai.integration_id = i.id
    WHERE ai.automation_id = ${automationId} AND i.enabled
    ORDER BY i.name, i.id
  `);
}
