import { sql } from 'drizzle-orm';
import type { JsonValue } from '../shared/json.ts';
import { execute, queryOne, queryRows, sqlValueList, withTransaction } from './postgres.ts';
import type { IntegrationRow } from './integrations.ts';

export interface RepositorySettings {
  reviewOnPush?: boolean;
  checkCommand?: string;
}

export interface RepositoryRow {
  id: number;
  organization_id: string;
  source_integration_id: number;
  external_id: string | null;
  owner: string;
  name: string;
  default_branch: string | null;
  enabled: boolean;
  settings: JsonValue;
  created_at: string;
  updated_at: string;
  source_kind: IntegrationRow['kind'];
  source_provider: string;
  source_external_account_id: string | null;
  source_config: JsonValue;
}

export interface RepositoryRefRow {
  repository_id: number;
  ref: string;
  head_sha: string;
  updated_at: string;
}

export async function listRepositories(organizationIds: string[]): Promise<RepositoryRow[]> {
  if (organizationIds.length === 0) return [];
  return queryRows<RepositoryRow>(sql`
    SELECT r.*, i.kind AS source_kind, i.provider AS source_provider,
      i.external_account_id AS source_external_account_id, i.config AS source_config
    FROM app.repositories r
    JOIN app.integrations i ON i.id = r.source_integration_id
    WHERE r.organization_id IN (${sqlValueList(organizationIds)})
    ORDER BY r.owner, r.name, r.id
  `);
}

export async function getRepository(id: number): Promise<RepositoryRow | null> {
  return queryOne<RepositoryRow>(sql`
    SELECT r.*, i.kind AS source_kind, i.provider AS source_provider,
      i.external_account_id AS source_external_account_id, i.config AS source_config
    FROM app.repositories r
    JOIN app.integrations i ON i.id = r.source_integration_id
    WHERE r.id = ${id}
  `);
}

export async function getRepositoryByFullName(
  owner: string,
  name: string,
  provider = 'github',
): Promise<RepositoryRow | null> {
  return queryOne<RepositoryRow>(sql`
    SELECT r.*, i.kind AS source_kind, i.provider AS source_provider,
      i.external_account_id AS source_external_account_id, i.config AS source_config
    FROM app.repositories r
    JOIN app.integrations i ON i.id = r.source_integration_id
    WHERE r.owner = ${owner} AND r.name = ${name} AND i.provider = ${provider}
    ORDER BY r.id
    LIMIT 1
  `);
}

export async function getRepositoryByExternalId(
  integrationId: number,
  externalId: string,
): Promise<RepositoryRow | null> {
  return queryOne<RepositoryRow>(sql`
    SELECT r.*, i.kind AS source_kind, i.provider AS source_provider,
      i.external_account_id AS source_external_account_id, i.config AS source_config
    FROM app.repositories r
    JOIN app.integrations i ON i.id = r.source_integration_id
    WHERE r.source_integration_id = ${integrationId} AND r.external_id = ${externalId}
  `);
}

export async function getRepositoryByProviderExternalId(
  provider: string,
  externalId: string,
): Promise<RepositoryRow | null> {
  return queryOne<RepositoryRow>(sql`
    SELECT r.*, i.kind AS source_kind, i.provider AS source_provider,
      i.external_account_id AS source_external_account_id, i.config AS source_config
    FROM app.repositories r
    JOIN app.integrations i ON i.id = r.source_integration_id
    WHERE i.provider = ${provider} AND r.external_id = ${externalId}
    ORDER BY r.id
    LIMIT 1
  `);
}

export async function upsertRepositories(
  integration: IntegrationRow,
  repos: Array<{
    externalId?: string | null;
    owner: string;
    name: string;
    defaultBranch?: string | null;
  }>,
): Promise<void> {
  await withTransaction(async (transaction) => {
    for (const repo of repos) {
      const existing = await transaction.execute(sql`
        SELECT id FROM app.repositories
        WHERE source_integration_id = ${integration.id}
          AND (
            (${repo.externalId ?? null}::text IS NOT NULL AND external_id = ${repo.externalId ?? null})
            OR (owner = ${repo.owner} AND name = ${repo.name})
          )
      `);
      const id = existing.rows[0]?.id;
      if (id) {
        await transaction.execute(sql`
          UPDATE app.repositories SET
            external_id = COALESCE(${repo.externalId ?? null}, external_id),
            owner = ${repo.owner}, name = ${repo.name},
            default_branch = COALESCE(${repo.defaultBranch ?? null}, default_branch),
            enabled = TRUE, updated_at = CURRENT_TIMESTAMP
          WHERE id = ${Number(id)}
        `);
      } else {
        await transaction.execute(sql`
          INSERT INTO app.repositories (
            organization_id, source_integration_id, external_id, owner, name, default_branch
          ) VALUES (
            ${integration.organization_id}, ${integration.id}, ${repo.externalId ?? null},
            ${repo.owner}, ${repo.name},
            ${repo.defaultBranch ?? null}
          )
        `);
      }
    }
  });
}

export async function removeRepositories(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await execute(sql`DELETE FROM app.repositories WHERE id IN (${sqlValueList(ids)})`);
}

export async function disableRepositoriesForIntegration(integrationId: number): Promise<void> {
  await execute(sql`
    UPDATE app.repositories SET enabled = FALSE, updated_at = CURRENT_TIMESTAMP
    WHERE source_integration_id = ${integrationId}
  `);
}

export async function updateRepository(
  id: number,
  input: { enabled?: boolean; settings?: JsonValue; defaultBranch?: string | null },
): Promise<void> {
  await execute(sql`
    UPDATE app.repositories SET
      enabled = COALESCE(${input.enabled ?? null}, enabled),
      settings = COALESCE(${input.settings ? JSON.stringify(input.settings) : null}::jsonb, settings),
      default_branch = CASE
        WHEN ${input.defaultBranch === undefined} THEN default_branch
        ELSE ${input.defaultBranch ?? null}
      END,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${id}
  `);
}

export async function replaceRepositorySettings(id: number, settings: JsonValue): Promise<void> {
  await execute(sql`
    UPDATE app.repositories SET settings = ${JSON.stringify(settings)}::jsonb,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${id}
  `);
}

export async function recordRepositoryRef(
  repositoryId: number,
  ref: string,
  headSha: string,
): Promise<void> {
  await execute(sql`
    INSERT INTO app.repository_refs (repository_id, organization_id, ref, head_sha)
    SELECT id, organization_id, ${ref}, ${headSha}
    FROM app.repositories WHERE id = ${repositoryId}
    ON CONFLICT(repository_id, ref) DO UPDATE
    SET head_sha = excluded.head_sha, updated_at = CURRENT_TIMESTAMP
  `);
}

export async function deleteRepositoryRef(repositoryId: number, ref: string): Promise<void> {
  await execute(sql`
    DELETE FROM app.repository_refs WHERE repository_id = ${repositoryId} AND ref = ${ref}
  `);
}

export async function repositoryRef(
  repositoryId: number,
  ref: string,
): Promise<RepositoryRefRow | null> {
  return queryOne<RepositoryRefRow>(sql`
    SELECT * FROM app.repository_refs WHERE repository_id = ${repositoryId} AND ref = ${ref}
  `);
}

export async function repositoryRefs(repositoryId: number): Promise<RepositoryRefRow[]> {
  return queryRows<RepositoryRefRow>(sql`
    SELECT * FROM app.repository_refs WHERE repository_id = ${repositoryId} ORDER BY ref
  `);
}
