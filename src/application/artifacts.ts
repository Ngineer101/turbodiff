import { env } from 'cloudflare:workers';
import type { ZodType } from 'zod';
import { isNumber, isString } from '../shared/json.ts';
import { parseJson, type JsonValue } from '../shared/json.ts';
import {
  getArtifact,
  getArtifactByStorageKey,
  recordArtifact,
  type ArtifactRow,
} from '../data/db.ts';

const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(body: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', body));
}

export async function persistArtifactBody(input: {
  organizationId: string;
  kind: string;
  schemaVersion?: number;
  storageKey: string;
  contentType: string;
  body: string | Uint8Array;
}): Promise<ArtifactRow> {
  const bytes = isString(input.body) ? encoder.encode(input.body) : input.body;
  const contentHash = await sha256(bytes);
  const existing = await getArtifactByStorageKey(input.storageKey);
  if (existing) {
    if (
      existing.organization_id !== input.organizationId ||
      existing.kind !== input.kind ||
      existing.content_hash !== contentHash
    ) {
      throw new Error(`artifact key ${input.storageKey} is already bound to different content`);
    }
    return existing;
  }

  await env.ARTIFACTS.put(input.storageKey, bytes, {
    httpMetadata: { contentType: input.contentType },
  });
  try {
    return await recordArtifact({
      organizationId: input.organizationId,
      kind: input.kind,
      schemaVersion: input.schemaVersion ?? 1,
      storageKey: input.storageKey,
      contentType: input.contentType,
      contentHash,
      sizeBytes: bytes.byteLength,
    });
  } catch (failure) {
    const raced = await getArtifactByStorageKey(input.storageKey);
    if (raced?.content_hash === contentHash && raced.organization_id === input.organizationId) {
      return raced;
    }
    throw failure;
  }
}

export async function persistJsonArtifact<Artifact>(input: {
  organizationId: string;
  kind: string;
  schemaVersion?: number;
  storageKey: string;
  schema: ZodType<Artifact>;
  value: Artifact;
}): Promise<ArtifactRow> {
  const value = input.schema.parse(input.value);
  return persistArtifactBody({
    ...input,
    contentType: 'application/json',
    body: JSON.stringify(value),
  });
}

export async function loadJsonArtifact<Artifact>(
  artifactOrId: ArtifactRow | number,
  schema: ZodType<Artifact>,
): Promise<Artifact> {
  const artifact = isNumber(artifactOrId) ? await getArtifact(artifactOrId) : artifactOrId;
  if (!artifact) throw new Error('artifact was not found');
  const object = await env.ARTIFACTS.get(artifact.storage_key);
  if (!object) throw new Error(`artifact body ${artifact.storage_key} was not found`);
  return schema.parse(await object.json());
}

export async function loadArtifactBody(artifact: ArtifactRow): Promise<JsonValue> {
  const object = await env.ARTIFACTS.get(artifact.storage_key);
  if (!object) throw new Error(`artifact body ${artifact.storage_key} was not found`);
  const body = await object.text();
  return artifact.content_type.includes('json') ? parseJson(body) : body;
}
