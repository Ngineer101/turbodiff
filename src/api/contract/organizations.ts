import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from '@effect/platform';
import { Schema } from 'effect';
import { DomainError } from './errors.ts';

const PositiveInt = Schema.Int.pipe(Schema.positive());
const installationId = HttpApiSchema.param(
  'installationId',
  Schema.NumberFromString.pipe(Schema.int(), Schema.positive()),
);
const memberId = HttpApiSchema.param('memberId', Schema.String);
const invitationId = HttpApiSchema.param('invitationId', Schema.String);
const Role = Schema.Literal('owner', 'admin', 'member');

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
  organizationName: Schema.String,
  installationId: Schema.NullOr(PositiveInt),
  invitedBy: Schema.NullOr(Schema.String),
  expiresAt: Schema.NullOr(Schema.String),
});
export type InvitationPreview = typeof InvitationPreview.Type;
export const InvitationAcceptance = Schema.Struct({
  organizationName: Schema.String,
  installationId: Schema.NullOr(PositiveInt),
});
export type InvitationAcceptance = typeof InvitationAcceptance.Type;

export const OrganizationsApi = HttpApiGroup.make('organizations')
  .add(
    HttpApiEndpoint.get('listOrganizationMembers')`/organizations/${installationId}/members`
      .addSuccess(OrganizationMembers)
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.post(
      'createOrganizationInvitation',
    )`/organizations/${installationId}/invitations`
      .setPayload(CreateInvitation)
      .addSuccess(Invitation, { status: 201 })
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.patch(
      'updateOrganizationMember',
    )`/organizations/${installationId}/members/${memberId}`
      .setPayload(UpdateMember)
      .addSuccess(HttpApiSchema.NoContent, { status: 204 })
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.del(
      'deleteOrganizationMember',
    )`/organizations/${installationId}/members/${memberId}`
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
