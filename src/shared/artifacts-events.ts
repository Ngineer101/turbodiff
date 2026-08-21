import { isJsonObject, isString } from './json.ts';

// Cloudflare Artifacts event envelopes, delivered as Workflow params by the
// `triggers.events` entries in wrangler.jsonc (docs/artifacts-provider.md).
// Typed to the documented schema
// (developers.cloudflare.com/queues/event-subscriptions/events-schemas/) and
// parsed defensively at the boundary: the platform versions the schema
// (metadata.eventSchemaVersion), so an unrecognized shape degrades to null
// instead of a workflow crash-loop.

export const ARTIFACTS_PUSHED = 'cf.artifacts.repo.pushed';
export const ARTIFACTS_REPO_DELETED = 'cf.artifacts.repo.deleted';

export interface ArtifactsPushedEvent {
  type: typeof ARTIFACTS_PUSHED;
  namespace: string;
  repoName: string;
  // e.g. "refs/heads/main"
  ref: string;
  before: string;
  after: string;
  eventTimestamp: string | null;
}

export interface ArtifactsRepoLifecycleEvent {
  // repo.created / repo.deleted / repo.forked / repo.imported and any future
  // non-push repo event.
  type: string;
  namespace: string;
  repoName: string;
  eventTimestamp: string | null;
}

export type ArtifactsEvent = ArtifactsPushedEvent | ArtifactsRepoLifecycleEvent;

export function isArtifactsPushedEvent(event: ArtifactsEvent): event is ArtifactsPushedEvent {
  return event.type === ARTIFACTS_PUSHED;
}

// Generic like the json.ts guards so callers keep their type evidence; the
// workflow hands its untyped params straight in and gets a domain event out.
export function parseArtifactsEvent<T>(raw: T): ArtifactsEvent | null {
  if (!isJsonObject(raw) || !isString(raw.type) || !raw.type.startsWith('cf.artifacts.')) {
    return null;
  }
  const source = isJsonObject(raw.source) ? raw.source : null;
  if (!source || !isString(source.namespace) || !isString(source.repoName)) return null;
  const metadata = isJsonObject(raw.metadata) ? raw.metadata : null;
  const eventTimestamp =
    metadata && isString(metadata.eventTimestamp) ? metadata.eventTimestamp : null;

  if (raw.type === ARTIFACTS_PUSHED) {
    const payload = isJsonObject(raw.payload) ? raw.payload : null;
    if (
      !payload ||
      !isString(payload.ref) ||
      !isString(payload.before) ||
      !isString(payload.after)
    ) {
      return null;
    }
    return {
      type: ARTIFACTS_PUSHED,
      namespace: source.namespace,
      repoName: source.repoName,
      ref: payload.ref,
      before: payload.before,
      after: payload.after,
      eventTimestamp,
    };
  }
  return {
    type: raw.type,
    namespace: source.namespace,
    repoName: source.repoName,
    eventTimestamp,
  };
}
