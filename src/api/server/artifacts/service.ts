import { Context, Effect, Layer } from 'effect';
import { loadArtifactBody } from '../../../application/artifacts.ts';
import { getArtifact } from '../../../data/db.ts';
import type { Artifact } from '../../contract/artifacts.ts';
import type { CurrentUserIdentity } from '../../contract/auth.ts';
import { internalServerError, notFound, type DomainError } from '../../contract/errors.ts';

const operation = <Value>(run: () => Promise<Value>): Effect.Effect<Value, DomainError> =>
  Effect.tryPromise({
    try: run,
    catch: (failure) => {
      console.error('turbodiff: artifact operation failed', failure);
      return internalServerError();
    },
  });

export interface ArtifactOperations {
  readonly get: (user: CurrentUserIdentity, id: number) => Effect.Effect<Artifact, DomainError>;
}

export class ArtifactService extends Context.Tag('Turbodiff/ArtifactService')<
  ArtifactService,
  ArtifactOperations
>() {}

export const ArtifactServiceLive = Layer.succeed(ArtifactService, {
  get: (user, id) =>
    Effect.gen(function* () {
      const row = yield* operation(() => getArtifact(id));
      if (!row || !user.organizationIds.includes(row.organization_id)) {
        return yield* Effect.fail(notFound('Unknown artifact'));
      }
      return {
        id: row.id,
        organizationId: row.organization_id,
        kind: row.kind,
        schemaVersion: row.schema_version,
        contentType: row.content_type,
        contentHash: row.content_hash,
        sizeBytes: row.size_bytes,
        value: yield* operation(() => loadArtifactBody(row)),
        createdAt: row.created_at,
      };
    }),
} satisfies ArtifactOperations);
