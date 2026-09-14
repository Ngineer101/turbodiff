import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from '@effect/platform';
import { Schema } from 'effect';
import { DomainError } from './errors.ts';

const organizationId = HttpApiSchema.param('organizationId', Schema.String);
const memberId = HttpApiSchema.param('memberId', Schema.String);
const invitationId = HttpApiSchema.param('invitationId', Schema.String);
const Role = Schema.Literal('owner', 'admin', 'member');

export const Organization = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  slug: Schema.String,
  role: Role,
  createdAt: Schema.String,
});
export type Organization = typeof Organization.Type;
export const OrganizationCollection = Schema.Struct({ items: Schema.Array(Organization) });

export const Member = Schema.Struct({
  id: Schema.String,
  login: Schema.NullOr(Schema.String),
  email: Schema.String,
  role: Role,
  joinedAt: Schema.String,
});
export const Invitation = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  role: Role,
  status: Schema.String,
  expiresAt: Schema.NullOr(Schema.String),
});
export type Invitation = typeof Invitation.Type;
export const OrganizationMembers = Schema.Struct({
  organizationId: Schema.String,
  myRole: Role,
  members: Schema.Array(Member),
  invitations: Schema.Array(Invitation),
});
export type OrganizationMembers = typeof OrganizationMembers.Type;
export const CreateInvitation = Schema.Struct({ email: Schema.String, role: Role });
export const UpdateMember = Schema.Struct({ role: Role });
export const InvitationPreview = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  role: Role,
  organizationId: Schema.String,
  organizationName: Schema.String,
  invitedBy: Schema.NullOr(Schema.String),
  expiresAt: Schema.NullOr(Schema.String),
});
export type InvitationPreview = typeof InvitationPreview.Type;
export const InvitationAcceptance = Schema.Struct({
  organizationId: Schema.String,
  organizationName: Schema.String,
});
export type InvitationAcceptance = typeof InvitationAcceptance.Type;

export const OrganizationsApi = HttpApiGroup.make('organizations')
  .add(
    HttpApiEndpoint.get('listOrganizations', '/organizations')
      .addSuccess(OrganizationCollection)
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.get('listOrganizationMembers')`/organizations/${organizationId}/members`
      .addSuccess(OrganizationMembers)
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.post(
      'createOrganizationInvitation',
    )`/organizations/${organizationId}/invitations`
      .setPayload(CreateInvitation)
      .addSuccess(Invitation, { status: 201 })
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.patch(
      'updateOrganizationMember',
    )`/organizations/${organizationId}/members/${memberId}`
      .setPayload(UpdateMember)
      .addSuccess(HttpApiSchema.NoContent, { status: 204 })
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.del(
      'deleteOrganizationMember',
    )`/organizations/${organizationId}/members/${memberId}`
      .addSuccess(HttpApiSchema.NoContent, { status: 204 })
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.get('getInvitation')`/invitations/${invitationId}`
      .addSuccess(InvitationPreview)
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.post('acceptInvitation')`/invitations/${invitationId}/acceptances`
      .addSuccess(InvitationAcceptance, { status: 201 })
      .addError(DomainError),
  );
