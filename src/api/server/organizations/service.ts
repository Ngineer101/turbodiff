import { APIError } from 'better-auth';
import { Context, Effect, Layer } from 'effect';
import {
  getOrganization,
  inviterLabel,
  listMembers,
  listOrganizationMembershipsForUser,
  listPendingInvitations,
  memberRole,
} from '../../../data/organizations.ts';
import { withAuth } from '../../../integrations/auth/better-auth.ts';
import type { CurrentUserIdentity } from '../../contract/auth.ts';
import type {
  Invitation,
  InvitationAcceptance,
  InvitationPreview,
  OrganizationCollection,
  OrganizationMembers,
} from '../../contract/organizations.ts';
import {
  badRequest,
  conflict,
  forbidden,
  internalServerError,
  notFound,
  type DomainError,
} from '../../contract/errors.ts';
import { requireOrganization, requireOrganizationWrite } from '../authorization.ts';

type Role = 'owner' | 'admin' | 'member';

const role = (value: string): Role => (value === 'owner' || value === 'admin' ? value : 'member');

const operationError = <Failure>(failure: Failure): DomainError => {
  if (failure instanceof APIError) {
    if (failure.statusCode === 401 || failure.statusCode === 403) return forbidden(failure.message);
    if (failure.statusCode === 404) return notFound(failure.message);
    if (failure.statusCode === 409) return conflict(failure.message);
    return badRequest(failure.message);
  }
  console.error('turbodiff: organization operation failed', failure);
  return internalServerError();
};

const operation = <A>(run: () => Promise<A>): Effect.Effect<A, DomainError> =>
  Effect.tryPromise({ try: run, catch: operationError });

export interface OrganizationOperations {
  readonly list: (
    user: CurrentUserIdentity,
  ) => Effect.Effect<typeof OrganizationCollection.Type, DomainError>;
  readonly listMembers: (
    user: CurrentUserIdentity,
    organizationId: string,
  ) => Effect.Effect<OrganizationMembers, DomainError>;
  readonly invite: (
    user: CurrentUserIdentity,
    organizationId: string,
    headers: Headers,
    input: { email: string; role: Role },
  ) => Effect.Effect<Invitation, DomainError>;
  readonly updateMember: (
    user: CurrentUserIdentity,
    organizationId: string,
    memberId: string,
    headers: Headers,
    role: Role,
  ) => Effect.Effect<void, DomainError>;
  readonly removeMember: (
    user: CurrentUserIdentity,
    organizationId: string,
    memberId: string,
    headers: Headers,
  ) => Effect.Effect<void, DomainError>;
  readonly getInvitation: (
    headers: Headers,
    id: string,
  ) => Effect.Effect<InvitationPreview, DomainError>;
  readonly acceptInvitation: (
    headers: Headers,
    id: string,
  ) => Effect.Effect<InvitationAcceptance, DomainError>;
}

export class OrganizationService extends Context.Tag('Turbodiff/OrganizationService')<
  OrganizationService,
  OrganizationOperations
>() {}

export const OrganizationServiceLive = Layer.succeed(OrganizationService, {
  list: (user) =>
    operation(() => listOrganizationMembershipsForUser(user.session.authUserId)).pipe(
      Effect.map((rows) => ({
        items: rows.map((row) => ({
          id: row.id,
          name: row.name,
          slug: row.slug,
          role: role(row.role),
          createdAt: row.created_at,
        })),
      })),
    ),
  listMembers: (user, organizationId) =>
    Effect.gen(function* () {
      yield* requireOrganization(user, organizationId);
      const [members, invitations, ownRole] = yield* operation(() =>
        Promise.all([
          listMembers(organizationId),
          listPendingInvitations(organizationId),
          memberRole(organizationId, user.session.authUserId),
        ]),
      );
      if (!ownRole) return yield* Effect.fail(notFound('Unknown organization'));
      return {
        organizationId,
        myRole: ownRole,
        members: members.map((member) => ({
          id: member.id,
          login: member.login,
          email: member.email,
          role: role(member.role),
          joinedAt: member.created_at,
        })),
        invitations: invitations.map((invitation) => ({
          id: invitation.id,
          email: invitation.email,
          role: role(invitation.role),
          status: invitation.status,
          expiresAt: invitation.expires_at,
        })),
      };
    }),
  invite: (user, organizationId, headers, input) =>
    Effect.gen(function* () {
      yield* requireOrganizationWrite(user, organizationId);
      const email = input.email.trim();
      if (!email) return yield* Effect.fail(badRequest('Email is required'));
      const invitation = yield* operation(() =>
        withAuth((auth) =>
          auth.api.createInvitation({
            headers,
            body: { email, role: input.role, organizationId },
          }),
        ),
      );
      return {
        id: invitation.id,
        email: invitation.email,
        role: role(invitation.role),
        status: invitation.status,
        expiresAt: invitation.expiresAt ? new Date(invitation.expiresAt).toISOString() : null,
      };
    }),
  updateMember: (user, organizationId, memberId, headers, nextRole) =>
    Effect.gen(function* () {
      yield* requireOrganizationWrite(user, organizationId);
      yield* operation(() =>
        withAuth((auth) =>
          auth.api.updateMemberRole({
            headers,
            body: { memberId, role: nextRole, organizationId },
          }),
        ),
      );
    }),
  removeMember: (user, organizationId, memberId, headers) =>
    Effect.gen(function* () {
      yield* requireOrganizationWrite(user, organizationId);
      yield* operation(() =>
        withAuth((auth) =>
          auth.api.removeMember({
            headers,
            body: { memberIdOrEmail: memberId, organizationId },
          }),
        ),
      );
    }),
  getInvitation: (headers, id) =>
    Effect.gen(function* () {
      const invitation = yield* operation(() =>
        withAuth((auth) => auth.api.getInvitation({ headers, query: { id } })),
      );
      const [organization, invitedBy] = yield* operation(() =>
        Promise.all([
          getOrganization(invitation.organizationId),
          inviterLabel(invitation.inviterId),
        ]),
      );
      if (!organization) return yield* Effect.fail(notFound('Unknown organization'));
      return {
        id: invitation.id,
        email: invitation.email,
        role: role(invitation.role),
        organizationId: organization.id,
        organizationName: organization.name,
        invitedBy,
        expiresAt: invitation.expiresAt ? new Date(invitation.expiresAt).toISOString() : null,
      };
    }),
  acceptInvitation: (headers, id) =>
    Effect.gen(function* () {
      const accepted = yield* operation(() =>
        withAuth((auth) => auth.api.acceptInvitation({ headers, body: { invitationId: id } })),
      );
      const organization = yield* operation(() =>
        getOrganization(accepted.invitation.organizationId),
      );
      if (!organization) return yield* Effect.fail(notFound('Unknown organization'));
      return { organizationId: organization.id, organizationName: organization.name };
    }),
} satisfies OrganizationOperations);
