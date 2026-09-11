import { env } from 'cloudflare:workers';
import type { ZodType } from 'zod';

export async function writeArtifact<Artifact>(
  key: string,
  schema: ZodType<Artifact>,
  artifact: Artifact,
): Promise<void> {
  const validated = schema.parse(artifact);
  await env.ARTIFACTS.put(key, JSON.stringify(validated), {
    httpMetadata: { contentType: 'application/json' },
  });
}

export async function readArtifact<Artifact>(
  key: string,
  schema: ZodType<Artifact>,
): Promise<Artifact> {
  const object = await env.ARTIFACTS.get(key);
  if (!object) throw new Error(`artifact ${key} was not found`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await object.text());
  } catch {
    throw new Error(`artifact ${key} is not valid JSON`);
  }
  return schema.parse(parsed);
}
