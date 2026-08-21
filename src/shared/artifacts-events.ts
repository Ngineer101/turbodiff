// Cloudflare Artifacts event-subscription messages (see
// docs/artifacts-spike.md and developers.cloudflare.com/artifacts/guides/
// event-subscriptions/). They arrive on the factory queue next to
// FactoryMessage bodies — a second queue consumer hangs the local dev plugin
// (see wrangler.jsonc) — so the two families must be discriminable: factory
// messages carry `kind`, Artifacts events carry a `type` beginning with
// "cf.artifacts.".

import { isJsonObject, isString, type JsonValue } from './json.ts';

export interface ArtifactsQueueEvent {
  // e.g. "cf.artifacts.repo.created", "cf.artifacts.repo.pushed"
  type: string;
  source?: JsonValue;
  payload?: JsonValue;
  metadata?: JsonValue;
}

// Generic like the json.ts guards so call sites keep their type evidence:
// at the queue boundary this narrows the true branch to the event and the
// else branch back to FactoryMessage.
export function isArtifactsQueueEvent<T>(body: T): body is T & ArtifactsQueueEvent {
  return isJsonObject(body) && isString(body.type) && body.type.startsWith('cf.artifacts.');
}
