import { HttpApiBuilder, HttpServerRequest } from '@effect/platform';
import { Effect } from 'effect';
import { AppApi } from '../../contract/api.ts';
import { CurrentUser } from '../../contract/auth.ts';
import { serviceUnavailable } from '../../contract/errors.ts';
import { OrganizationService } from './service.ts';

const requestHeaders = Effect.flatMap(HttpServerRequest.HttpServerRequest, (serverRequest) =>
  serverRequest.source instanceof Request
    ? Effect.succeed(serverRequest.source.headers)
    : Effect.fail(serviceUnavailable('The request adapter is unavailable')),
);

export const OrganizationsHandlers = HttpApiBuilder.group(
  AppApi,
  'organizations',
  Effect.fn(function* (handlers) {
    const service = yield* OrganizationService;
    return handlers
      .handle('listOrganizationMembers', ({ path }) =>
        Effect.flatMap(CurrentUser, (user) => service.listMembers(user, path.installationId)),
      )
      .handle('createOrganizationInvitation', ({ path, payload }) =>
        Effect.all([CurrentUser, requestHeaders]).pipe(
          Effect.flatMap(([user, headers]) =>
            service.invite(user, path.installationId, headers, payload),
          ),
        ),
      )
      .handle('updateOrganizationMember', ({ path, payload }) =>
        Effect.all([CurrentUser, requestHeaders]).pipe(
          Effect.flatMap(([user, headers]) =>
            service.updateMember(user, path.installationId, path.memberId, headers, payload.role),
          ),
        ),
      )
      .handle('deleteOrganizationMember', ({ path }) =>
        Effect.all([CurrentUser, requestHeaders]).pipe(
          Effect.flatMap(([user, headers]) =>
            service.removeMember(user, path.installationId, path.memberId, headers),
          ),
        ),
      )
      .handle('getInvitation', ({ path }) =>
        Effect.flatMap(requestHeaders, (headers) =>
          service.getInvitation(headers, path.invitationId),
        ),
      )
      .handle('acceptInvitation', ({ path }) =>
        Effect.flatMap(requestHeaders, (headers) =>
          service.acceptInvitation(headers, path.invitationId),
        ),
      );
  }),
);
