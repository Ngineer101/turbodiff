import { Effect } from 'effect';
import { capabilityDenied } from '../../application/auth/access-control.ts';
import type { CurrentUserIdentity } from '../contract/auth.ts';
import { forbidden, internalServerError, type DomainError } from '../contract/errors.ts';
import type { ApiRuntimeDependencies } from './context.ts';

export const capableInstallationIds = (
  user: CurrentUserIdentity,
  dependencies: ApiRuntimeDependencies,
): Effect.Effect<number[], DomainError> =>
  Effect.tryPromise({
    try: () =>
      Promise.all(
        user.installationIds.map(async (installationId) =>
          (await capabilityDenied(user, installationId, 'settings', dependencies.orgAdmin))
            ? null
            : installationId,
        ),
      ),
    catch: (error) => {
      console.error('turbodiff: Effect authorization check failed', error);
      return internalServerError();
    },
  }).pipe(
    Effect.map((ids) => ids.filter((id): id is number => id !== null)),
    Effect.flatMap((ids) =>
      ids.length > 0
        ? Effect.succeed(ids)
        : Effect.fail(forbidden("'settings' capability required for this action")),
    ),
  );
