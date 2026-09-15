import { sql } from 'drizzle-orm';
import { queryOne } from './postgres.ts';

export interface ArtifactRow {
  id: number;
  organization_id: string;
  kind: string;
  schema_version: number;
  storage_key: string;
  content_type: string;
  content_hash: string;
  size_bytes: number;
  created_at: string;
}

export async function recordArtifact(input: {
  organizationId: string;
  kind: string;
  schemaVersion: number;
  storageKey: string;
  contentType: string;
  contentHash: string;
  sizeBytes: number;
}): Promise<ArtifactRow> {
  const row = await queryOne<ArtifactRow>(sql`
    INSERT INTO app.artifacts (
      organization_id, kind, schema_version, storage_key, content_type, content_hash, size_bytes
    ) VALUES (
      ${input.organizationId}, ${input.kind}, ${input.schemaVersion}, ${input.storageKey},
      ${input.contentType}, ${input.contentHash}, ${input.sizeBytes}
    )
    RETURNING *
  `);
  if (!row) throw new Error('artifact insert returned no row');
  return row;
}

export async function getArtifact(id: number): Promise<ArtifactRow | null> {
  return queryOne<ArtifactRow>(sql`SELECT * FROM app.artifacts WHERE id = ${id}`);
}

export async function getArtifactByStorageKey(storageKey: string): Promise<ArtifactRow | null> {
  return queryOne<ArtifactRow>(sql`
    SELECT * FROM app.artifacts WHERE storage_key = ${storageKey}
  `);
}
