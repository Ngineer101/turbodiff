import { Effect } from 'effect';
import { memberRole } from '../../data/db.ts';
import type { CurrentUserIdentity } from '../contract/auth.ts';
import { forbidden, internalServerError, notFound, type DomainError } from '../contract/errors.ts';

export const dataEffect = <A>(run: () => Promise<A>): Effect.Effect<A, DomainError> =>
  Effect.tryPromise({
    try: run,
    catch: (error) => {
      console.error('turbodiff: API operation failed', error);
      return internalServerError();
    },
  });

export const requireOrganization = (
  user: CurrentUserIdentity,
  organizationId: string,
): Effect.Effect<void, DomainError> =>
  user.organizationIds.includes(organizationId)
    ? Effect.void
    : Effect.fail(notFound('Unknown organization'));

export const requireOrganizationWrite = (
  user: CurrentUserIdentity,
  organizationId: string,
): Effect.Effect<void, DomainError> =>
  requireOrganization(user, organizationId).pipe(
    Effect.andThen(dataEffect(() => memberRole(organizationId, user.session.authUserId))),
    Effect.flatMap((role) =>
      role === 'owner' || role === 'admin'
        ? Effect.void
        : Effect.fail(forbidden('Organization admin role required')),
    ),
  );
