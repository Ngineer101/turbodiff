import { APIError } from 'better-auth';
import { Context, Effect, Layer } from 'effect';
import { listMembersWithGithubLogin, listPendingInvitations } from '../../../data/db.ts';
import { withAuth } from '../../../integrations/auth/better-auth.ts';
import {
  capabilityDenied,
  inviterLabel,
  memberRole,
  organizationSummary,
  orgForInstallationWithHeal,
} from '../../../application/auth/access-control.ts';
import type { CurrentUserIdentity } from '../../contract/auth.ts';
import type {
  Invitation,
  InvitationAcceptance,
  InvitationPreview,
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
import { ApiDependencies } from '../context.ts';

type Role = 'owner' | 'admin' | 'member';
const role = (value: string): Role => (value === 'owner' || value === 'admin' ? value : 'member');

const apiError = (error: Error): DomainError => {
  if (error instanceof APIError) {
    const detail = error.message;
    if (error.statusCode === 401) return forbidden(detail);
    if (error.statusCode === 403) return forbidden(detail);
    if (error.statusCode === 404) return notFound(detail);
    if (error.statusCode === 409) return conflict(detail);
    return badRequest(detail);
  }
  console.error('turbodiff: organization operation failed', error);
  return internalServerError();
};

const operation = <A>(run: () => Promise<A>): Effect.Effect<A, DomainError> =>
  Effect.tryPromise({
    try: run,
    catch: (failure) =>
      apiError(failure instanceof Error ? failure : new Error('Unknown organization failure')),
  });

export interface OrganizationOperations {
  readonly listMembers: (
    user: CurrentUserIdentity,
    installationId: number,
  ) => Effect.Effect<OrganizationMembers, DomainError>;
  readonly invite: (
    user: CurrentUserIdentity,
    installationId: number,
    headers: Headers,
    input: { email: string; role: Role },
  ) => Effect.Effect<Invitation, DomainError>;
  readonly updateMember: (
    user: CurrentUserIdentity,
    installationId: number,
    memberId: string,
    headers: Headers,
    role: Role,
  ) => Effect.Effect<void, DomainError>;
  readonly removeMember: (
    user: CurrentUserIdentity,
    installationId: number,
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

export const OrganizationServiceLive = Layer.effect(
  OrganizationService,
  Effect.gen(function* () {
    const dependencies = yield* ApiDependencies;

    const organization = (user: CurrentUserIdentity, installationId: number) => {
      if (!user.installationIds.includes(installationId)) {
        return Effect.fail(notFound('Unknown organization'));
      }
      return operation(() =>
        orgForInstallationWithHeal(user, installationId, dependencies.orgAdmin),
      ).pipe(
        Effect.flatMap((found) =>
          found ? Effect.succeed(found) : Effect.fail(notFound('Unknown organization')),
        ),
      );
    };

    const requireMemberWrite = (user: CurrentUserIdentity, installationId: number) =>
      operation(() => capabilityDenied(user, installationId, 'member', dependencies.orgAdmin)).pipe(
        Effect.flatMap((denial) => (denial ? Effect.fail(forbidden(denial)) : Effect.void)),
      );

    return {
      listMembers: (user, installationId) =>
        Effect.gen(function* () {
          const org = yield* organization(user, installationId);
          const [members, invitations, myRole] = yield* operation(() =>
            Promise.all([
              listMembersWithGithubLogin(org.id),
              listPendingInvitations(org.id),
              memberRole(org.id, user.session.userId),
            ]),
          );
          return {
            organizationId: org.id,
            myRole,
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
      invite: (user, installationId, headers, input) =>
        Effect.gen(function* () {
          const org = yield* organization(user, installationId);
          yield* requireMemberWrite(user, installationId);
          const email = input.email.trim();
          if (!email) return yield* Effect.fail(badRequest('Email is required'));
          const invitation = yield* operation(() =>
            withAuth((instance) =>
              instance.api.createInvitation({
                headers,
                body: { email, role: input.role, organizationId: org.id },
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
      updateMember: (user, installationId, memberId, headers, nextRole) =>
        Effect.gen(function* () {
          const org = yield* organization(user, installationId);
          yield* requireMemberWrite(user, installationId);
          yield* operation(() =>
            withAuth((instance) =>
              instance.api.updateMemberRole({
                headers,
                body: { memberId, role: nextRole, organizationId: org.id },
              }),
            ),
          );
        }),
      removeMember: (user, installationId, memberId, headers) =>
        Effect.gen(function* () {
          const org = yield* organization(user, installationId);
          yield* requireMemberWrite(user, installationId);
          yield* operation(() =>
            withAuth((instance) =>
              instance.api.removeMember({
                headers,
                body: { memberIdOrEmail: memberId, organizationId: org.id },
              }),
            ),
          );
        }),
      getInvitation: (headers, id) =>
        Effect.gen(function* () {
          const invitation = yield* operation(() =>
            withAuth((instance) => instance.api.getInvitation({ headers, query: { id } })),
          );
          const [org, invitedBy] = yield* operation(() =>
            Promise.all([
              organizationSummary(invitation.organizationId),
              inviterLabel(invitation.inviterId),
            ]),
          );
          return {
            id: invitation.id,
            email: invitation.email,
            role: role(invitation.role),
            organizationName: org?.name ?? invitation.organizationName,
            installationId: org?.installationId ?? null,
            invitedBy,
            expiresAt: invitation.expiresAt ? new Date(invitation.expiresAt).toISOString() : null,
          };
        }),
      acceptInvitation: (headers, id) =>
        Effect.gen(function* () {
          const accepted = yield* operation(() =>
            withAuth((instance) =>
              instance.api.acceptInvitation({ headers, body: { invitationId: id } }),
            ),
          );
          const org = yield* operation(() =>
            organizationSummary(accepted.invitation.organizationId),
          );
          return {
            organizationName: org?.name ?? '',
            installationId: org?.installationId ?? null,
          };
        }),
    } satisfies OrganizationOperations;
  }),
);
