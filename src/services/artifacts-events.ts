import { env } from 'cloudflare:workers';
import type { ArtifactsQueueEvent } from '../shared/artifacts-events.ts';
import { parseJson, type JsonValue } from '../shared/json.ts';

// Phase-0 spike capture (docs/artifacts-spike.md): Artifacts events are
// written raw to the R2 evidence bucket instead of a D1 table so the
// throwaway spike needs no migration. Objects stay private — /artifacts/*
// only serves signed capability URLs, and no signature is ever issued for
// this prefix.

const EVENTS_PREFIX = 'artifacts-spike/events/';

export async function recordArtifactsEvent(event: ArtifactsQueueEvent): Promise<void> {
  const key = `${EVENTS_PREFIX}${new Date().toISOString()}-${event.type}-${crypto.randomUUID().slice(0, 8)}.json`;
  await env.ARTIFACTS.put(key, JSON.stringify(event, null, 2), {
    httpMetadata: { contentType: 'application/json' },
  });
}

export interface RecordedArtifactsEvent {
  key: string;
  event: JsonValue;
}

export async function listArtifactsEvents(limit = 50): Promise<RecordedArtifactsEvent[]> {
  const listing = await env.ARTIFACTS.list({ prefix: EVENTS_PREFIX, limit });
  const events: RecordedArtifactsEvent[] = [];
  for (const object of listing.objects) {
    const stored = await env.ARTIFACTS.get(object.key);
    if (!stored) continue;
    events.push({ key: object.key, event: parseJson(await stored.text()) });
  }
  return events;
}
