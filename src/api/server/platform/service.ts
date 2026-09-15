import { Context, Effect, Layer } from 'effect';
import { listGithubInstallationIds } from '../../../data/integrations.ts';
import {
  deletePushSubscription,
  upsertPushSubscription,
} from '../../../data/push-subscriptions.ts';
import type { CurrentUserIdentity } from '../../contract/auth.ts';
import type { CurrentUserView, PushSubscriptionInput } from '../../contract/platform.ts';
import { badRequest, internalServerError, type DomainError } from '../../contract/errors.ts';
import { ApiDependencies } from '../context.ts';

export interface PlatformOperations {
  readonly currentUser: (user: CurrentUserIdentity) => Effect.Effect<CurrentUserView, DomainError>;
  readonly subscribe: (
    user: CurrentUserIdentity,
    subscription: PushSubscriptionInput,
  ) => Effect.Effect<{ endpoint: string }, DomainError>;
  readonly unsubscribe: (
    user: CurrentUserIdentity,
    endpoint: string,
  ) => Effect.Effect<void, DomainError>;
}

export class PlatformService extends Context.Tag('Turbodiff/PlatformService')<
  PlatformService,
  PlatformOperations
>() {}

const databaseEffect = <A>(operation: () => Promise<A>): Effect.Effect<A, DomainError> =>
  Effect.tryPromise({
    try: operation,
    catch: (error) => {
      console.error('turbodiff: Effect platform operation failed', error);
      return internalServerError();
    },
  });

export const PlatformServiceLive = Layer.effect(
  PlatformService,
  Effect.gen(function* () {
    const dependencies = yield* ApiDependencies;
    return {
      currentUser: (user) =>
        databaseEffect(() => listGithubInstallationIds(user.organizationIds)).pipe(
          Effect.map((githubInstallationIds) => ({
            login: user.githubConnected ? user.session.login : null,
            name: user.name,
            githubConnected: user.githubConnected,
            githubStatus: user.githubStatus,
            githubAppSlug: dependencies.githubAppSlug,
            vapidPublicKey: dependencies.vapidPublicKey,
            activeOrganizationId: user.activeOrganizationId,
            organizationIds: user.organizationIds,
            githubInstallationIds,
          })),
        ),
      subscribe: (user, input) =>
        Effect.gen(function* () {
          const endpoint = input.endpoint.trim();
          const p256dh = input.keys.p256dh.trim();
          const auth = input.keys.auth.trim();
          if (!endpoint || !p256dh || !auth) {
            return yield* Effect.fail(badRequest('A complete push subscription is required'));
          }
          yield* databaseEffect(() =>
            upsertPushSubscription(user.session.authUserId, { endpoint, p256dh, auth }),
          );
          return { endpoint };
        }),
      unsubscribe: (user, rawEndpoint) =>
        Effect.gen(function* () {
          const endpoint = rawEndpoint.trim();
          if (!endpoint) return yield* Effect.fail(badRequest('endpoint is required'));
          yield* databaseEffect(() => deletePushSubscription(user.session.authUserId, endpoint));
        }),
    } satisfies PlatformOperations;
  }),
);
