import { sql } from 'drizzle-orm';
import { execute, queryOne, queryRows, withTransaction } from './database.ts';

export type ChangeStatus = 'open' | 'merged' | 'closed';

export interface ChangeRow {
  id: number;
  organization_id: string;
  repository_id: number;
  delivery_id: number | null;
  provider_integration_id: number;
  provider_key: string;
  number: number | null;
  title: string;
  source_ref: string;
  target_ref: string;
  url: string | null;
  origin: 'human' | 'factory' | 'automation' | 'imported';
  status: ChangeStatus;
  created_at: string;
  updated_at: string;
}

export interface ChangeRevisionRow {
  id: number;
  organization_id: string;
  change_id: number;
  version: number;
  base_sha: string;
  head_sha: string;
  artifact_id: number;
  created_at: string;
}

export interface ReviewOutcomeRow {
  agent_run_id: number;
  organization_id: string;
  change_revision_id: number;
  verdict: 'approve' | 'comment' | 'request_changes';
  conclusion: 'ready' | 'ready_with_warnings' | 'not_ready' | 'inconclusive';
  coverage_status: 'complete' | 'incomplete' | 'stale';
  finding_count: number;
  publication_url: string | null;
  published_at: string | null;
  created_at: string;
}

export async function upsertChange(input: {
  organizationId: string;
  repositoryId: number;
  deliveryId?: number | null;
  providerIntegrationId: number;
  providerKey: string;
  number?: number | null;
  title: string;
  sourceRef: string;
  targetRef: string;
  url?: string | null;
  origin: ChangeRow['origin'];
  status?: ChangeStatus;
}): Promise<ChangeRow> {
  const row = await queryOne<ChangeRow>(sql`
    INSERT INTO app.changes (
      organization_id, repository_id, delivery_id, provider_integration_id, provider_key,
      number, title, source_ref, target_ref, url, origin, status
    ) VALUES (
      ${input.organizationId}, ${input.repositoryId}, ${input.deliveryId ?? null},
      ${input.providerIntegrationId}, ${input.providerKey}, ${input.number ?? null},
      ${input.title}, ${input.sourceRef}, ${input.targetRef}, ${input.url ?? null},
      ${input.origin}, ${input.status ?? 'open'}
    )
    ON CONFLICT(provider_integration_id, provider_key) DO UPDATE SET
      delivery_id = COALESCE(excluded.delivery_id, changes.delivery_id),
      number = excluded.number, title = excluded.title, source_ref = excluded.source_ref,
      target_ref = excluded.target_ref, url = excluded.url, status = excluded.status,
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
  providerIntegrationId: number,
  providerKey: string,
): Promise<ChangeRow | null> {
  return queryOne<ChangeRow>(sql`
    SELECT * FROM app.changes
    WHERE provider_integration_id = ${providerIntegrationId} AND provider_key = ${providerKey}
  `);
}

export async function listChangesForRepository(repositoryId: number): Promise<ChangeRow[]> {
  return queryRows<ChangeRow>(sql`
    SELECT * FROM app.changes WHERE repository_id = ${repositoryId}
    ORDER BY updated_at DESC, id DESC
  `);
}

export async function listChangesForDelivery(deliveryId: number): Promise<ChangeRow[]> {
  return queryRows<ChangeRow>(sql`
    SELECT * FROM app.changes WHERE delivery_id = ${deliveryId}
    ORDER BY updated_at DESC, id DESC
  `);
}

export async function updateChangeStatus(id: number, status: ChangeStatus): Promise<void> {
  await execute(sql`
    UPDATE app.changes SET status = ${status}, updated_at = CURRENT_TIMESTAMP WHERE id = ${id}
  `);
}

export async function createChangeRevision(input: {
  change: ChangeRow;
  baseSha: string;
  headSha: string;
  artifactId: number;
}): Promise<ChangeRevisionRow> {
  return withTransaction(async () => {
    await execute(sql`SELECT id FROM app.changes WHERE id = ${input.change.id} FOR UPDATE`);
    const row = await queryOne<ChangeRevisionRow>(sql`
      INSERT INTO app.change_revisions (
        organization_id, change_id, version, base_sha, head_sha, artifact_id
      ) VALUES (
        ${input.change.organization_id}, ${input.change.id},
        COALESCE((SELECT MAX(version) + 1 FROM app.change_revisions
          WHERE change_id = ${input.change.id}), 1),
        ${input.baseSha}, ${input.headSha}, ${input.artifactId}
      )
      ON CONFLICT(change_id, head_sha) DO UPDATE SET base_sha = excluded.base_sha
      RETURNING *
    `);
    if (!row) throw new Error('change revision insert returned no row');
    return row;
  });
}

export async function latestChangeRevision(changeId: number): Promise<ChangeRevisionRow | null> {
  return queryOne<ChangeRevisionRow>(sql`
    SELECT * FROM app.change_revisions
    WHERE change_id = ${changeId}
    ORDER BY version DESC
    LIMIT 1
  `);
}

export async function getChangeRevision(id: number): Promise<ChangeRevisionRow | null> {
  return queryOne<ChangeRevisionRow>(sql`
    SELECT * FROM app.change_revisions WHERE id = ${id}
  `);
}

export async function recordReviewOutcome(input: {
  organizationId: string;
  agentRunId: number;
  changeRevisionId: number;
  verdict: ReviewOutcomeRow['verdict'];
  conclusion: ReviewOutcomeRow['conclusion'];
  coverageStatus: ReviewOutcomeRow['coverage_status'];
  findingCount: number;
  publicationUrl?: string | null;
}): Promise<void> {
  await execute(sql`
    INSERT INTO app.review_outcomes (
      organization_id, agent_run_id, change_revision_id, verdict, conclusion, coverage_status,
      finding_count, publication_url, published_at
    ) VALUES (
      ${input.organizationId}, ${input.agentRunId}, ${input.changeRevisionId}, ${input.verdict}, ${input.conclusion},
      ${input.coverageStatus}, ${input.findingCount}, ${input.publicationUrl ?? null},
      ${input.publicationUrl ? new Date().toISOString() : null}
    )
    ON CONFLICT(agent_run_id) DO UPDATE SET
      change_revision_id = excluded.change_revision_id,
      verdict = excluded.verdict,
      conclusion = excluded.conclusion,
      coverage_status = excluded.coverage_status,
      finding_count = excluded.finding_count,
      publication_url = excluded.publication_url,
      published_at = excluded.published_at
  `);
}

export async function listReviewOutcomes(changeRevisionId: number): Promise<ReviewOutcomeRow[]> {
  return queryRows<ReviewOutcomeRow>(sql`
    SELECT * FROM app.review_outcomes
    WHERE change_revision_id = ${changeRevisionId}
    ORDER BY agent_run_id
  `);
}
