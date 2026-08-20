import { createAccessControl } from 'better-auth/plugins/access';
import { defaultStatements } from 'better-auth/plugins/organization/access';

// Better Auth's organization permission vocabulary. Both the adapter and
// application authorization service must use these exact role objects.
const orgStatement = {
  ...defaultStatements,
  settings: ['update'],
} as const;

export const orgAc = createAccessControl(orgStatement);

export const orgRoles = {
  owner: orgAc.newRole({
    organization: ['update', 'delete'],
    member: ['create', 'update', 'delete'],
    invitation: ['create', 'cancel'],
    team: [],
    ac: [],
    settings: ['update'],
  }),
  admin: orgAc.newRole({
    organization: ['update'],
    member: ['create', 'update', 'delete'],
    invitation: ['create', 'cancel'],
    team: [],
    ac: [],
    settings: ['update'],
  }),
  member: orgAc.newRole({
    organization: [],
    member: [],
    invitation: [],
    team: [],
    ac: [],
    settings: [],
  }),
};

export type OrgRole = keyof typeof orgRoles;
