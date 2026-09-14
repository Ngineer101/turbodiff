import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from '@effect/platform';
import { Schema } from 'effect';
import { DomainError } from './errors.ts';

const PositiveInt = Schema.Int.pipe(Schema.positive());
const artifactId = HttpApiSchema.param(
  'artifactId',
  Schema.NumberFromString.pipe(Schema.int(), Schema.positive()),
);

export const Artifact = Schema.Struct({
  id: PositiveInt,
  organizationId: Schema.String,
  kind: Schema.String,
  schemaVersion: PositiveInt,
  contentType: Schema.String,
  contentHash: Schema.String,
  sizeBytes: Schema.Number,
  value: Schema.Unknown,
  createdAt: Schema.String,
});
export type Artifact = typeof Artifact.Type;

export const ArtifactsApi = HttpApiGroup.make('artifacts').add(
  HttpApiEndpoint.get('getArtifact')`/artifacts/${artifactId}`
    .addSuccess(Artifact)
    .addError(DomainError),
);
