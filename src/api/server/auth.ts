import { HttpApp, HttpServerRequest } from '@effect/platform';
import { Effect, Layer } from 'effect';
import { notifyInstallationsLive } from '../../application/notifications/live-updates.ts';
import { SessionAuth, type CurrentUserIdentity } from '../contract/auth.ts';
import { forbidden, serviceUnavailable, unauthorized } from '../contract/errors.ts';
import { ApiDependencies } from './context.ts';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const SessionAuthLive = Layer.effect(
  SessionAuth,
  Effect.gen(function* () {
    const dependencies = yield* ApiDependencies;

    return Effect.gen(function* () {
      const serverRequest = yield* HttpServerRequest.HttpServerRequest;
      const request = serverRequest.source;
      if (!(request instanceof Request)) {
        return yield* Effect.fail(serviceUnavailable('The request adapter is unavailable'));
      }

      if (!SAFE_METHODS.has(request.method)) {
        const origin = request.headers.get('origin');
        if (origin && origin !== new URL(request.url).origin) {
          return yield* Effect.fail(forbidden('Cross-origin request rejected'));
        }
      }

      const user = yield* Effect.tryPromise({
        try: () => dependencies.authenticate(request),
        catch: () => serviceUnavailable('Session validation is temporarily unavailable'),
      });
      if (!user) return yield* Effect.fail(unauthorized());

      if (user.membershipRefresh) dependencies.defer(user.membershipRefresh());
      if (user.repositoryRepair) dependencies.defer(user.repositoryRepair());
      if (!SAFE_METHODS.has(request.method)) {
        yield* HttpApp.appendPreResponseHandler((_request, response) =>
          Effect.sync(() => {
            if (response.status < 400) {
              dependencies.defer(
                notifyInstallationsLive(user.installationIds).catch((error) => {
                  console.warn('turbodiff: live write invalidation failed', error);
                }),
              );
            }
            return response;
          }),
        );
      }
      return user satisfies CurrentUserIdentity;
    });
  }),
);
