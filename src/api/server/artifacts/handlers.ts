import { HttpApiBuilder } from '@effect/platform';
import { Effect } from 'effect';
import { AppApi } from '../../contract/api.ts';
import { CurrentUser } from '../../contract/auth.ts';
import { ArtifactService } from './service.ts';

export const ArtifactsHandlers = HttpApiBuilder.group(
  AppApi,
  'artifacts',
  Effect.fn(function* (handlers) {
    const service = yield* ArtifactService;
    return handlers.handle('getArtifact', ({ path }) =>
      Effect.flatMap(CurrentUser, (user) => service.get(user, path.artifactId)),
    );
  }),
);
