import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform';
import { Schema } from 'effect';
import { DomainError } from './errors.ts';

const withDomainErrors = <
  Name extends string,
  Method extends 'GET' | 'POST' | 'DELETE',
  Path,
  UrlParams,
  Payload,
  Headers,
  Success,
  Error,
  R,
  RE,
>(
  endpoint: HttpApiEndpoint.HttpApiEndpoint<
    Name,
    Method,
    Path,
    UrlParams,
    Payload,
    Headers,
    Success,
    Error,
    R,
    RE
  >,
) => endpoint.addError(DomainError);

export const CurrentUserView = Schema.Struct({
  login: Schema.NullOr(Schema.String),
  name: Schema.String,
  githubConnected: Schema.Boolean,
  githubStatus: Schema.Literal(
    'not_connected',
    'reauthorization_required',
    'temporarily_unavailable',
    'app_not_installed',
    'syncing',
    'ready',
  ),
  githubAppSlug: Schema.String,
  vapidPublicKey: Schema.String,
  installationIds: Schema.Array(Schema.Int),
});

export type CurrentUserView = typeof CurrentUserView.Type;

export const PushSubscriptionInput = Schema.Struct({
  endpoint: Schema.String,
  keys: Schema.Struct({ p256dh: Schema.String, auth: Schema.String }),
});

export type PushSubscriptionInput = typeof PushSubscriptionInput.Type;

export const PushSubscription = Schema.Struct({ endpoint: Schema.String });

export const DeletePushSubscription = Schema.Struct({ endpoint: Schema.String });

export const PlatformApi = HttpApiGroup.make('platform')
  .add(withDomainErrors(HttpApiEndpoint.get('getCurrentUser', '/me').addSuccess(CurrentUserView)))
  .add(
    withDomainErrors(
      HttpApiEndpoint.post('createPushSubscription', '/push-subscriptions')
        .setPayload(PushSubscriptionInput)
        .addSuccess(PushSubscription, { status: 201 }),
    ),
  )
  .add(
    withDomainErrors(
      HttpApiEndpoint.del('deletePushSubscription', '/push-subscriptions')
        .setPayload(DeletePushSubscription)
        .addSuccess(Schema.Void, { status: 204 }),
    ),
  );
