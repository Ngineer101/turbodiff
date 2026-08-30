import { sql } from 'drizzle-orm';
import type { ChangeCapability, ChangeOrigin } from '../domain/lifecycle-contract.ts';
import { execute, queryOne, queryRows } from './database.ts';

export type ChangeStatus = 'open' | 'merged' | 'closed';

export interface ChangeRow {
  id: number;
  repository_id: number;
  provider_key: string;
  number: number;
  origin: ChangeOrigin;
  title: string;
  external_url: string | null;
  source_branch: string;
  target_branch: string;
  status: ChangeStatus;
  source_head: string | null;
  target_head: string | null;
  draft: boolean;
  capabilities: ChangeCapability[];
  provider_updated_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface UpsertChangeInput {
  repositoryId: number;
  providerKey: string;
  number: number;
  origin: ChangeOrigin;
  title: string;
  externalUrl: string | null;
  sourceBranch: string;
  targetBranch: string;
  status: ChangeStatus;
  sourceHead: string | null;
  targetHead: string | null;
  draft: boolean;
  capabilities: ChangeCapability[];
  providerUpdatedAt?: string | null;
}

export function changeProviderKey(provider: 'github' | 'artifacts', number: number): string {
  return `${provider}:${number}`;
}

// Provider deliveries and factory completion can race. This upsert is the
// single canonicalization point: mutable provider facts refresh in place,
// while an established factory/automation origin cannot be downgraded by a
// later generic webhook observation.
export async function upsertChange(input: UpsertChangeInput): Promise<ChangeRow> {
  const row = await queryOne<ChangeRow>(sql`
    INSERT INTO app.changes (
      repository_id, provider_key, number, origin, title, external_url,
      source_branch, target_branch, status, source_head, target_head, draft,
      capabilities, provider_updated_at
    ) VALUES (
      ${input.repositoryId}, ${input.providerKey}, ${input.number}, ${input.origin},
      ${input.title}, ${input.externalUrl}, ${input.sourceBranch}, ${input.targetBranch},
      ${input.status}, ${input.sourceHead}, ${input.targetHead}, ${input.draft},
      ${JSON.stringify(input.capabilities)}::jsonb, ${input.providerUpdatedAt ?? null}
    )
    ON CONFLICT (repository_id, provider_key) DO UPDATE SET
      number = EXCLUDED.number,
      origin = CASE
        WHEN changes.origin IN ('factory', 'automation')
          AND EXCLUDED.origin IN ('human', 'imported') THEN changes.origin
        ELSE EXCLUDED.origin
      END,
      title = EXCLUDED.title,
      external_url = COALESCE(EXCLUDED.external_url, changes.external_url),
      source_branch = EXCLUDED.source_branch,
      target_branch = EXCLUDED.target_branch,
      status = EXCLUDED.status,
      source_head = COALESCE(EXCLUDED.source_head, changes.source_head),
      target_head = COALESCE(EXCLUDED.target_head, changes.target_head),
      draft = EXCLUDED.draft,
      capabilities = EXCLUDED.capabilities,
      provider_updated_at = COALESCE(EXCLUDED.provider_updated_at, changes.provider_updated_at),
      updated_at = CURRENT_TIMESTAMP
    RETURNING *
  `);
  if (!row) throw new Error('change upsert returned no row');
  return row;
}

export async function getChange(id: number): Promise<ChangeRow | null> {
  return queryOne<ChangeRow>(sql`SELECT * FROM app.changes WHERE id = ${id}`);
}

export async function getChangeByProviderKey(
  repositoryId: number,
  providerKey: string,
): Promise<ChangeRow | null> {
  return queryOne<ChangeRow>(sql`
    SELECT * FROM app.changes
    WHERE repository_id = ${repositoryId} AND provider_key = ${providerKey}
  `);
}

export async function listChangesForRepo(
  repositoryId: number,
  status?: ChangeStatus,
): Promise<ChangeRow[]> {
  const statusFilter = status ? sql`AND status = ${status}` : sql.empty();
  return queryRows<ChangeRow>(sql`
    SELECT * FROM app.changes
    WHERE repository_id = ${repositoryId} ${statusFilter}
    ORDER BY number DESC
  `);
}

export async function linkFeatureToChange(featureId: number, changeId: number): Promise<void> {
  await execute(sql`UPDATE app.features SET change_id = ${changeId} WHERE id = ${featureId}`);
}

export async function updateCanonicalChangeState(
  id: number,
  state: {
    status?: ChangeStatus;
    sourceHead?: string;
    targetHead?: string;
    draft?: boolean;
  },
): Promise<void> {
  await execute(sql`
    UPDATE app.changes SET
      status = COALESCE(${state.status ?? null}::text, status),
      source_head = COALESCE(${state.sourceHead ?? null}::text, source_head),
      target_head = COALESCE(${state.targetHead ?? null}::text, target_head),
      draft = COALESCE(${state.draft ?? null}::boolean, draft),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${id}
  `);
}
