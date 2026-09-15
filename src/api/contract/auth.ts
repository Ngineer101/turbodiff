import { HttpApiMiddleware } from '@effect/platform';
import { Context, Schema } from 'effect';
import { Forbidden, ServiceUnavailable, Unauthorized } from './errors.ts';

export interface CurrentUserIdentity {
  readonly session: {
    readonly authUserId: string;
    readonly githubUserId: number | null;
    readonly login: string | null;
  };
  readonly organizationIds: string[];
  readonly activeOrganizationId: string;
  readonly githubConnected: boolean;
  readonly githubStatus:
    | 'not_connected'
    | 'reauthorization_required'
    | 'temporarily_unavailable'
    | 'app_not_installed'
    | 'syncing'
    | 'ready';
  readonly name: string;
}

export class CurrentUser extends Context.Tag('Turbodiff/CurrentUser')<
  CurrentUser,
  CurrentUserIdentity
>() {}

export class SessionAuth extends HttpApiMiddleware.Tag<SessionAuth>()('Turbodiff/SessionAuth', {
  failure: Schema.Union(Unauthorized, Forbidden, ServiceUnavailable),
  provides: CurrentUser,
}) {}
