import { sql } from 'drizzle-orm';
import type { JsonValue } from '../shared/json.ts';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  foreignKey,
  type ForeignKeyBuilder,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

function factoryRunParentForeignKey(table: {
  parentRunId: AnyPgColumn;
  organizationId: AnyPgColumn;
}): ForeignKeyBuilder {
  return foreignKey({
    columns: [table.parentRunId, table.organizationId],
    foreignColumns: [factoryRuns.id, factoryRuns.organizationId],
  }).onDelete('restrict');
}

export const appSchema = pgSchema('app');
export const authSchema = pgSchema('auth');

export const user = authSchema.table(
  'user',
  {
    id: text().primaryKey().notNull(),
    name: text().notNull(),
    email: text().notNull(),
    emailVerified: boolean().default(false).notNull(),
    image: text(),
    createdAt: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
    updatedAt: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
    login: text(),
    githubId: bigint({ mode: 'number' }),
  },
  (table) => [
    unique('user_email_unique').on(table.email),
    unique('user_github_id_unique').on(table.githubId),
  ],
);

export const organization = authSchema.table(
  'organization',
  {
    id: text().primaryKey().notNull(),
    name: text().notNull(),
    slug: text().notNull(),
    logo: text(),
    metadata: text(),
    createdAt: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [unique('organization_slug_key').on(table.slug)],
);

export const session = authSchema.table(
  'session',
  {
    id: text().primaryKey().notNull(),
    expiresAt: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
    token: text().notNull(),
    createdAt: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
    updatedAt: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
    ipAddress: text(),
    userAgent: text(),
    activeOrganizationId: text(),
    userId: text().notNull(),
  },
  (table) => [
    index('session_active_organization_idx').on(table.activeOrganizationId),
    index('session_expires_at_idx').on(table.expiresAt),
    index('session_user_id_idx').on(table.userId),
    foreignKey({
      columns: [table.activeOrganizationId],
      foreignColumns: [organization.id],
      name: 'session_active_organization_fkey',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: 'session_user_id_fkey',
    }).onDelete('cascade'),
    unique('session_token_unique').on(table.token),
  ],
);

export const account = authSchema.table(
  'account',
  {
    id: text().primaryKey().notNull(),
    accountId: text().notNull(),
    providerId: text().notNull(),
    userId: text().notNull(),
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    accessTokenExpiresAt: timestamp({ withTimezone: true, mode: 'string' }),
    refreshTokenExpiresAt: timestamp({ withTimezone: true, mode: 'string' }),
    scope: text(),
    password: text(),
    createdAt: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
    updatedAt: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    index('account_user_id_idx').on(table.userId),
    foreignKey({ columns: [table.userId], foreignColumns: [user.id] }).onDelete('cascade'),
    unique('account_provider_identity_unique').on(table.accountId, table.providerId),
  ],
);

export const verification = authSchema.table(
  'verification',
  {
    id: text().primaryKey().notNull(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
    createdAt: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
    updatedAt: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    index('verification_expires_at_idx').on(table.expiresAt),
    index('verification_identifier_idx').on(table.identifier),
  ],
);

export const oauthApplication = authSchema.table(
  'oauthApplication',
  {
    id: text().primaryKey().notNull(),
    name: text(),
    icon: text(),
    metadata: text(),
    clientId: text().notNull(),
    clientSecret: text(),
    redirectUrls: text().notNull(),
    type: text().notNull(),
    disabled: boolean().default(false).notNull(),
    userId: text(),
    createdAt: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
    updatedAt: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    index('oauth_application_user_id_idx').on(table.userId),
    foreignKey({ columns: [table.userId], foreignColumns: [user.id] }).onDelete('cascade'),
    unique('oauthApplication_clientId_key').on(table.clientId),
  ],
);

export const oauthAccessToken = authSchema.table(
  'oauthAccessToken',
  {
    id: text().primaryKey().notNull(),
    accessToken: text().notNull(),
    refreshToken: text(),
    accessTokenExpiresAt: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
    refreshTokenExpiresAt: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
    clientId: text().notNull(),
    userId: text(),
    scopes: text().notNull(),
    createdAt: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
    updatedAt: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    index('oauth_access_token_client_id_idx').on(table.clientId),
    index('oauth_access_token_expiry_idx').on(table.accessTokenExpiresAt),
    index('oauth_access_token_user_id_idx').on(table.userId),
    foreignKey({ columns: [table.clientId], foreignColumns: [oauthApplication.clientId] }).onDelete(
      'cascade',
    ),
    foreignKey({ columns: [table.userId], foreignColumns: [user.id] }).onDelete('cascade'),
    unique('oauthAccessToken_accessToken_key').on(table.accessToken),
    unique('oauthAccessToken_refreshToken_key').on(table.refreshToken),
  ],
);

export const oauthConsent = authSchema.table(
  'oauthConsent',
  {
    id: text().primaryKey().notNull(),
    clientId: text().notNull(),
    userId: text().notNull(),
    scopes: text().notNull(),
    consentGiven: boolean().default(false).notNull(),
    createdAt: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
    updatedAt: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    index('oauth_consent_client_id_idx').on(table.clientId),
    index('oauth_consent_user_id_idx').on(table.userId),
    foreignKey({ columns: [table.clientId], foreignColumns: [oauthApplication.clientId] }).onDelete(
      'cascade',
    ),
    foreignKey({ columns: [table.userId], foreignColumns: [user.id] }).onDelete('cascade'),
    unique('oauth_consent_client_user_unique').on(table.clientId, table.userId),
  ],
);

export const member = authSchema.table(
  'member',
  {
    id: text().primaryKey().notNull(),
    organizationId: text().notNull(),
    userId: text().notNull(),
    role: text().default('member').notNull(),
    createdAt: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    index('member_user_id_idx').on(table.userId),
    foreignKey({ columns: [table.organizationId], foreignColumns: [organization.id] }).onDelete(
      'cascade',
    ),
    foreignKey({ columns: [table.userId], foreignColumns: [user.id] }).onDelete('cascade'),
    unique('member_organization_user_unique').on(table.organizationId, table.userId),
    check('member_role_check', sql`role = ANY (ARRAY['owner', 'admin', 'member'])`),
  ],
);

export const invitation = authSchema.table(
  'invitation',
  {
    id: text().primaryKey().notNull(),
    organizationId: text().notNull(),
    email: text().notNull(),
    role: text().notNull(),
    status: text().default('pending').notNull(),
    expiresAt: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
    createdAt: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
    inviterId: text().notNull(),
  },
  (table) => [
    index('invitation_email_status_idx').on(table.email, table.status),
    index('invitation_inviter_idx').on(table.inviterId),
    index('invitation_organization_idx').on(table.organizationId, table.status),
    foreignKey({ columns: [table.organizationId], foreignColumns: [organization.id] }).onDelete(
      'cascade',
    ),
    foreignKey({ columns: [table.inviterId], foreignColumns: [user.id] }).onDelete('cascade'),
    uniqueIndex('invitation_pending_email_unique')
      .on(table.organizationId, sql`lower(${table.email})`)
      .where(sql`status = 'pending'`),
    check('invitation_role_check', sql`role = ANY (ARRAY['owner', 'admin', 'member'])`),
    check(
      'invitation_status_check',
      sql`status = ANY (ARRAY['pending', 'accepted', 'rejected', 'canceled'])`,
    ),
  ],
);

export const integrations = appSchema.table(
  'integrations',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
    organizationId: text('organization_id').notNull(),
    kind: text().notNull(),
    provider: text().notNull(),
    name: text().notNull(),
    externalAccountId: text('external_account_id'),
    config: jsonb().$type<JsonValue>().default({}).notNull(),
    authCiphertext: text('auth_ciphertext'),
    authExpiresAt: timestamp('auth_expires_at', { withTimezone: true, mode: 'string' }),
    needsReauthorization: boolean('needs_reauthorization').default(false).notNull(),
    enabled: boolean().default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('integrations_organization_kind_idx').on(table.organizationId, table.kind),
    foreignKey({ columns: [table.organizationId], foreignColumns: [organization.id] }).onDelete(
      'cascade',
    ),
    unique('integrations_id_organization_unique').on(table.id, table.organizationId),
    unique('integrations_organization_name_unique').on(table.organizationId, table.name),
    uniqueIndex('integrations_external_account_unique')
      .on(table.provider, table.externalAccountId)
      .where(sql`external_account_id IS NOT NULL`),
    check(
      'integrations_kind_check',
      sql`kind = ANY (ARRAY['scm', 'artifact_store', 'mcp', 'api'])`,
    ),
    check('integrations_config_object_check', sql`jsonb_typeof(config) = 'object'`),
  ],
);

export const repositories = appSchema.table(
  'repositories',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
    organizationId: text('organization_id').notNull(),
    sourceIntegrationId: bigint('source_integration_id', { mode: 'number' }).notNull(),
    externalId: text('external_id'),
    owner: text().notNull(),
    name: text().notNull(),
    defaultBranch: text('default_branch'),
    enabled: boolean().default(true).notNull(),
    settings: jsonb().$type<JsonValue>().default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('repositories_source_integration_idx').on(table.sourceIntegrationId),
    index('repositories_organization_idx').on(table.organizationId, table.owner, table.name),
    foreignKey({ columns: [table.organizationId], foreignColumns: [organization.id] }).onDelete(
      'cascade',
    ),
    foreignKey({
      columns: [table.sourceIntegrationId, table.organizationId],
      foreignColumns: [integrations.id, integrations.organizationId],
    }).onDelete('restrict'),
    unique('repositories_id_organization_unique').on(table.id, table.organizationId),
    unique('repositories_source_owner_name_unique').on(
      table.sourceIntegrationId,
      table.owner,
      table.name,
    ),
    uniqueIndex('repositories_source_external_unique')
      .on(table.sourceIntegrationId, table.externalId)
      .where(sql`external_id IS NOT NULL`),
    check('repositories_settings_object_check', sql`jsonb_typeof(settings) = 'object'`),
  ],
);

export const models = appSchema.table(
  'models',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
    provider: text().notNull(),
    modelId: text('model_id').notNull(),
    label: text().notNull(),
    capabilities: text().array().default([]).notNull(),
    enabled: boolean().default(true).notNull(),
    isDefault: boolean('is_default').default(false).notNull(),
    isFastDefault: boolean('is_fast_default').default(false).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique('models_provider_model_unique').on(table.provider, table.modelId),
    uniqueIndex('models_default_unique')
      .on(table.isDefault)
      .where(sql`is_default`),
    uniqueIndex('models_fast_default_unique')
      .on(table.isFastDefault)
      .where(sql`is_fast_default`),
  ],
);

export const agents = appSchema.table(
  'agents',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
    organizationId: text('organization_id').notNull(),
    definitionKey: text('definition_key').notNull(),
    slug: text().notNull(),
    name: text().notNull(),
    description: text(),
    instructionsOverride: text('instructions_override'),
    enabled: boolean().default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('agents_organization_definition_idx').on(table.organizationId, table.definitionKey),
    foreignKey({ columns: [table.organizationId], foreignColumns: [organization.id] }).onDelete(
      'cascade',
    ),
    unique('agents_id_organization_unique').on(table.id, table.organizationId),
    unique('agents_organization_slug_unique').on(table.organizationId, table.slug),
    check('agents_slug_format', sql`slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'`),
  ],
);

export const skills = appSchema.table(
  'skills',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
    organizationId: text('organization_id').notNull(),
    slug: text().notNull(),
    name: text().notNull(),
    content: text().notNull(),
    contentHash: text('content_hash').notNull(),
    enabled: boolean().default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({ columns: [table.organizationId], foreignColumns: [organization.id] }).onDelete(
      'cascade',
    ),
    unique('skills_id_organization_unique').on(table.id, table.organizationId),
    unique('skills_organization_slug_unique').on(table.organizationId, table.slug),
    check('skills_slug_format', sql`slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'`),
  ],
);

export const automations = appSchema.table(
  'automations',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
    organizationId: text('organization_id').notNull(),
    agentId: bigint('agent_id', { mode: 'number' }).notNull(),
    repositoryId: bigint('repository_id', { mode: 'number' }),
    name: text().notNull(),
    schedule: text().notNull(),
    timezone: text().default('UTC').notNull(),
    inputTemplate: jsonb('input_template').$type<JsonValue>().notNull(),
    enabled: boolean().default(true).notNull(),
    nextRunAt: timestamp('next_run_at', { withTimezone: true, mode: 'string' }),
    createdByUserId: text('created_by_user_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('automations_agent_idx').on(table.agentId),
    index('automations_due_idx')
      .on(table.nextRunAt)
      .where(sql`enabled`),
    index('automations_repository_idx').on(table.repositoryId),
    index('automations_creator_idx').on(table.createdByUserId),
    foreignKey({ columns: [table.organizationId], foreignColumns: [organization.id] }).onDelete(
      'cascade',
    ),
    foreignKey({
      columns: [table.agentId, table.organizationId],
      foreignColumns: [agents.id, agents.organizationId],
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.repositoryId, table.organizationId],
      foreignColumns: [repositories.id, repositories.organizationId],
    }).onDelete('restrict'),
    foreignKey({ columns: [table.createdByUserId], foreignColumns: [user.id] }).onDelete(
      'restrict',
    ),
    unique('automations_id_organization_unique').on(table.id, table.organizationId),
    unique('automations_organization_name_unique').on(table.organizationId, table.name),
    check('automations_input_object_check', sql`jsonb_typeof(input_template) = 'object'`),
  ],
);

export const artifacts = appSchema.table(
  'artifacts',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
    organizationId: text('organization_id').notNull(),
    kind: text().notNull(),
    schemaVersion: integer('schema_version').notNull(),
    storageKey: text('storage_key').notNull(),
    contentType: text('content_type').default('application/json').notNull(),
    contentHash: text('content_hash').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('artifacts_organization_kind_idx').on(
      table.organizationId,
      table.kind,
      table.createdAt.desc(),
    ),
    foreignKey({ columns: [table.organizationId], foreignColumns: [organization.id] }).onDelete(
      'restrict',
    ),
    unique('artifacts_id_organization_unique').on(table.id, table.organizationId),
    unique('artifacts_storage_key_unique').on(table.storageKey),
    check('artifacts_schema_version_check', sql`schema_version > 0`),
    check('artifacts_size_bytes_check', sql`size_bytes >= 0`),
  ],
);

export const workItems = appSchema.table(
  'work_items',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
    organizationId: text('organization_id').notNull(),
    origin: text().notNull(),
    title: text().notNull(),
    description: text().notNull(),
    status: text().default('open').notNull(),
    archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'string' }),
    approvedPlanArtifactId: bigint('approved_plan_artifact_id', { mode: 'number' }),
    createdByUserId: text('created_by_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    index('work_items_organization_created_idx').on(table.organizationId, table.createdAt.desc()),
    index('work_items_approved_plan_idx').on(table.approvedPlanArtifactId),
    index('work_items_creator_idx').on(table.createdByUserId),
    foreignKey({ columns: [table.organizationId], foreignColumns: [organization.id] }).onDelete(
      'cascade',
    ),
    foreignKey({
      columns: [table.approvedPlanArtifactId, table.organizationId],
      foreignColumns: [artifacts.id, artifacts.organizationId],
    }).onDelete('restrict'),
    foreignKey({ columns: [table.createdByUserId], foreignColumns: [user.id] }).onDelete(
      'set null',
    ),
    unique('work_items_id_organization_unique').on(table.id, table.organizationId),
    check(
      'work_items_origin_check',
      sql`origin = ANY (ARRAY['idea', 'issue', 'external_change', 'automation', 'api'])`,
    ),
    check(
      'work_items_status_check',
      sql`status = ANY (ARRAY['open', 'planning', 'awaiting_approval', 'approved', 'in_progress', 'completed', 'cancelled'])`,
    ),
  ],
);

export const workItemTargets = appSchema.table(
  'work_item_targets',
  {
    workItemId: bigint('work_item_id', { mode: 'number' }).notNull(),
    repositoryId: bigint('repository_id', { mode: 'number' }).notNull(),
    organizationId: text('organization_id').notNull(),
    position: integer().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('work_item_targets_repository_idx').on(table.repositoryId),
    foreignKey({
      columns: [table.workItemId, table.organizationId],
      foreignColumns: [workItems.id, workItems.organizationId],
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.repositoryId, table.organizationId],
      foreignColumns: [repositories.id, repositories.organizationId],
    }).onDelete('restrict'),
    primaryKey({ columns: [table.workItemId, table.repositoryId] }),
    unique('work_item_targets_scope_unique').on(
      table.workItemId,
      table.repositoryId,
      table.organizationId,
    ),
    unique('work_item_targets_position_unique').on(table.workItemId, table.position),
    check('work_item_targets_position_check', sql`position >= 0 AND position < 3`),
  ],
);

export const deliveries = appSchema.table(
  'deliveries',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
    organizationId: text('organization_id').notNull(),
    workItemId: bigint('work_item_id', { mode: 'number' }).notNull(),
    repositoryId: bigint('repository_id', { mode: 'number' }).notNull(),
    status: text().default('pending').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    index('deliveries_organization_created_idx').on(table.organizationId, table.createdAt.desc()),
    index('deliveries_repository_idx').on(table.repositoryId, table.createdAt.desc()),
    foreignKey({
      columns: [table.workItemId, table.repositoryId, table.organizationId],
      foreignColumns: [
        workItemTargets.workItemId,
        workItemTargets.repositoryId,
        workItemTargets.organizationId,
      ],
    }).onDelete('cascade'),
    unique('deliveries_id_organization_unique').on(table.id, table.organizationId),
    unique('deliveries_work_item_repository_unique').on(table.workItemId, table.repositoryId),
    check(
      'deliveries_status_check',
      sql`status = ANY (ARRAY['pending', 'active', 'completed', 'failed', 'cancelled'])`,
    ),
  ],
);

export const acceptanceContracts = appSchema.table(
  'acceptance_contracts',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
    organizationId: text('organization_id').notNull(),
    deliveryId: bigint('delivery_id', { mode: 'number' }).notNull(),
    version: integer().notNull(),
    artifactId: bigint('artifact_id', { mode: 'number' }).notNull(),
    status: text().default('proposed').notNull(),
    createdByUserId: text('created_by_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('acceptance_contracts_artifact_idx').on(table.artifactId),
    index('acceptance_contracts_creator_idx').on(table.createdByUserId),
    foreignKey({
      columns: [table.deliveryId, table.organizationId],
      foreignColumns: [deliveries.id, deliveries.organizationId],
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.artifactId, table.organizationId],
      foreignColumns: [artifacts.id, artifacts.organizationId],
    }).onDelete('restrict'),
    foreignKey({ columns: [table.createdByUserId], foreignColumns: [user.id] }).onDelete(
      'set null',
    ),
    unique('acceptance_contracts_delivery_version_unique').on(table.deliveryId, table.version),
    uniqueIndex('acceptance_contracts_one_active_unique')
      .on(table.deliveryId)
      .where(sql`status = 'active'`),
    check('acceptance_contracts_version_check', sql`version > 0`),
    check(
      'acceptance_contracts_status_check',
      sql`status = ANY (ARRAY['proposed', 'active', 'rejected', 'superseded'])`,
    ),
  ],
);

export const changes = appSchema.table(
  'changes',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
    organizationId: text('organization_id').notNull(),
    repositoryId: bigint('repository_id', { mode: 'number' }).notNull(),
    deliveryId: bigint('delivery_id', { mode: 'number' }),
    providerIntegrationId: bigint('provider_integration_id', { mode: 'number' }).notNull(),
    providerKey: text('provider_key').notNull(),
    number: integer(),
    title: text().notNull(),
    sourceRef: text('source_ref').notNull(),
    targetRef: text('target_ref').notNull(),
    url: text(),
    origin: text().notNull(),
    status: text().default('open').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    deliveryRecoveryAt: timestamp('delivery_recovery_at', {
      withTimezone: true,
      mode: 'string',
    }),
  },
  (table) => [
    index('changes_repository_status_idx').on(table.repositoryId, table.status, table.createdAt),
    foreignKey({
      columns: [table.repositoryId, table.organizationId],
      foreignColumns: [repositories.id, repositories.organizationId],
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.deliveryId, table.organizationId],
      foreignColumns: [deliveries.id, deliveries.organizationId],
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.providerIntegrationId, table.organizationId],
      foreignColumns: [integrations.id, integrations.organizationId],
    }).onDelete('restrict'),
    unique('changes_id_organization_unique').on(table.id, table.organizationId),
    unique('changes_provider_key_unique').on(table.providerIntegrationId, table.providerKey),
    uniqueIndex('changes_delivery_unique')
      .on(table.deliveryId)
      .where(sql`delivery_id IS NOT NULL`),
    check('changes_number_check', sql`number IS NULL OR number > 0`),
    check(
      'changes_origin_check',
      sql`origin = ANY (ARRAY['human', 'factory', 'automation', 'imported'])`,
    ),
    check('changes_status_check', sql`status = ANY (ARRAY['open', 'merged', 'closed'])`),
  ],
);

export const changeRevisions = appSchema.table(
  'change_revisions',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
    organizationId: text('organization_id').notNull(),
    changeId: bigint('change_id', { mode: 'number' }).notNull(),
    version: integer().notNull(),
    baseSha: text('base_sha').notNull(),
    headSha: text('head_sha').notNull(),
    artifactId: bigint('artifact_id', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('change_revisions_artifact_idx').on(table.artifactId),
    foreignKey({
      columns: [table.changeId, table.organizationId],
      foreignColumns: [changes.id, changes.organizationId],
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.artifactId, table.organizationId],
      foreignColumns: [artifacts.id, artifacts.organizationId],
    }).onDelete('restrict'),
    unique('change_revisions_id_organization_unique').on(table.id, table.organizationId),
    unique('change_revisions_change_version_unique').on(table.changeId, table.version),
    unique('change_revisions_change_head_unique').on(table.changeId, table.headSha),
    check('change_revisions_version_check', sql`version > 0`),
  ],
);

export const factoryRuns = appSchema.table(
  'factory_runs',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
    organizationId: text('organization_id').notNull(),
    flowKey: text('flow_key').notNull(),
    flowVersion: integer('flow_version').notNull(),
    modelId: bigint('model_id', { mode: 'number' }),
    workItemId: bigint('work_item_id', { mode: 'number' }),
    deliveryId: bigint('delivery_id', { mode: 'number' }),
    changeId: bigint('change_id', { mode: 'number' }),
    automationId: bigint('automation_id', { mode: 'number' }),
    parentRunId: bigint('parent_run_id', { mode: 'number' }),
    trigger: text().notNull(),
    actorUserId: text('actor_user_id'),
    status: text().default('queued').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'string' }),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    index('factory_runs_work_item_idx').on(table.workItemId, table.createdAt.desc()),
    index('factory_runs_delivery_idx').on(table.deliveryId, table.createdAt.desc()),
    index('factory_runs_change_idx').on(table.changeId, table.createdAt.desc()),
    index('factory_runs_automation_idx').on(table.automationId, table.createdAt.desc()),
    index('factory_runs_parent_idx').on(table.parentRunId),
    index('factory_runs_actor_idx').on(table.actorUserId),
    index('factory_runs_model_idx').on(table.modelId),
    foreignKey({ columns: [table.organizationId], foreignColumns: [organization.id] }).onDelete(
      'restrict',
    ),
    foreignKey({ columns: [table.modelId], foreignColumns: [models.id] }).onDelete('restrict'),
    factoryRunParentForeignKey(table),
    foreignKey({
      columns: [table.workItemId, table.organizationId],
      foreignColumns: [workItems.id, workItems.organizationId],
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.deliveryId, table.organizationId],
      foreignColumns: [deliveries.id, deliveries.organizationId],
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.changeId, table.organizationId],
      foreignColumns: [changes.id, changes.organizationId],
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.automationId, table.organizationId],
      foreignColumns: [automations.id, automations.organizationId],
    }).onDelete('restrict'),
    foreignKey({ columns: [table.actorUserId], foreignColumns: [user.id] }).onDelete('set null'),
    unique('factory_runs_id_organization_unique').on(table.id, table.organizationId),
    unique('factory_runs_organization_idempotency_unique').on(
      table.organizationId,
      table.idempotencyKey,
    ),
    check('factory_runs_flow_version_check', sql`flow_version > 0`),
    check('factory_runs_scope_check', sql`num_nonnulls(work_item_id, delivery_id, change_id) = 1`),
    check(
      'factory_runs_status_check',
      sql`status = ANY (ARRAY['queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled'])`,
    ),
  ],
);

export const stageRuns = appSchema.table(
  'stage_runs',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
    organizationId: text('organization_id').notNull(),
    factoryRunId: bigint('factory_run_id', { mode: 'number' }).notNull(),
    stageKey: text('stage_key').notNull(),
    attempt: integer().default(1).notNull(),
    status: text().default('queued').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'string' }),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    index('stage_runs_factory_run_idx').on(table.factoryRunId, table.id),
    foreignKey({
      columns: [table.factoryRunId, table.organizationId],
      foreignColumns: [factoryRuns.id, factoryRuns.organizationId],
    }).onDelete('cascade'),
    unique('stage_runs_id_organization_unique').on(table.id, table.organizationId),
    unique('stage_runs_id_factory_organization_unique').on(
      table.id,
      table.factoryRunId,
      table.organizationId,
    ),
    unique('stage_runs_factory_stage_attempt_unique').on(
      table.factoryRunId,
      table.stageKey,
      table.attempt,
    ),
    unique('stage_runs_idempotency_unique').on(table.idempotencyKey),
    check('stage_runs_attempt_check', sql`attempt > 0`),
    check(
      'stage_runs_status_check',
      sql`status = ANY (ARRAY['queued', 'running', 'waiting', 'succeeded', 'failed', 'skipped', 'cancelled'])`,
    ),
  ],
);

export const agentRuns = appSchema.table(
  'agent_runs',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
    organizationId: text('organization_id').notNull(),
    stageRunId: bigint('stage_run_id', { mode: 'number' }).notNull(),
    agentId: bigint('agent_id', { mode: 'number' }).notNull(),
    modelId: bigint('model_id', { mode: 'number' }).notNull(),
    inputArtifactId: bigint('input_artifact_id', { mode: 'number' }).notNull(),
    outputArtifactId: bigint('output_artifact_id', { mode: 'number' }),
    logArtifactId: bigint('log_artifact_id', { mode: 'number' }),
    status: text().default('queued').notNull(),
    inputTokens: bigint('input_tokens', { mode: 'number' }).default(0).notNull(),
    outputTokens: bigint('output_tokens', { mode: 'number' }).default(0).notNull(),
    cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' }).default(0).notNull(),
    cacheWriteTokens: bigint('cache_write_tokens', { mode: 'number' }).default(0).notNull(),
    costUsd: numeric('cost_usd', { precision: 20, scale: 10, mode: 'number' }).default(0).notNull(),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'string' }),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    index('agent_runs_stage_run_idx').on(table.stageRunId, table.id),
    index('agent_runs_agent_idx').on(table.agentId, table.createdAt.desc()),
    index('agent_runs_model_idx').on(table.modelId),
    index('agent_runs_input_artifact_idx').on(table.inputArtifactId),
    index('agent_runs_log_artifact_idx').on(table.logArtifactId),
    index('agent_runs_organization_idx').on(table.organizationId, table.createdAt.desc()),
    foreignKey({ columns: [table.organizationId], foreignColumns: [organization.id] }).onDelete(
      'restrict',
    ),
    foreignKey({
      columns: [table.stageRunId, table.organizationId],
      foreignColumns: [stageRuns.id, stageRuns.organizationId],
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.agentId, table.organizationId],
      foreignColumns: [agents.id, agents.organizationId],
    }).onDelete('restrict'),
    foreignKey({ columns: [table.modelId], foreignColumns: [models.id] }).onDelete('restrict'),
    foreignKey({
      columns: [table.inputArtifactId, table.organizationId],
      foreignColumns: [artifacts.id, artifacts.organizationId],
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.outputArtifactId, table.organizationId],
      foreignColumns: [artifacts.id, artifacts.organizationId],
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.logArtifactId, table.organizationId],
      foreignColumns: [artifacts.id, artifacts.organizationId],
    }).onDelete('restrict'),
    unique('agent_runs_id_organization_unique').on(table.id, table.organizationId),
    unique('agent_runs_idempotency_unique').on(table.idempotencyKey),
    uniqueIndex('agent_runs_output_artifact_unique')
      .on(table.outputArtifactId)
      .where(sql`output_artifact_id IS NOT NULL`),
    check(
      'agent_runs_status_check',
      sql`status = ANY (ARRAY['queued', 'running', 'succeeded', 'failed', 'cancelled'])`,
    ),
    check(
      'agent_runs_usage_check',
      sql`input_tokens >= 0 AND output_tokens >= 0 AND cache_read_tokens >= 0 AND cache_write_tokens >= 0 AND cost_usd >= 0`,
    ),
  ],
);

export const lifecycleEvents = appSchema.table(
  'lifecycle_events',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
    organizationId: text('organization_id').notNull(),
    factoryRunId: bigint('factory_run_id', { mode: 'number' }).notNull(),
    stageRunId: bigint('stage_run_id', { mode: 'number' }),
    kind: text().notNull(),
    payload: jsonb().$type<JsonValue>().default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('lifecycle_events_factory_run_idx').on(table.factoryRunId, table.id),
    index('lifecycle_events_stage_run_idx').on(table.stageRunId),
    index('lifecycle_events_organization_idx').on(table.organizationId, table.createdAt.desc()),
    foreignKey({ columns: [table.organizationId], foreignColumns: [organization.id] }).onDelete(
      'restrict',
    ),
    foreignKey({
      columns: [table.factoryRunId, table.organizationId],
      foreignColumns: [factoryRuns.id, factoryRuns.organizationId],
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.stageRunId, table.factoryRunId, table.organizationId],
      foreignColumns: [stageRuns.id, stageRuns.factoryRunId, stageRuns.organizationId],
    }).onDelete('cascade'),
    check('lifecycle_events_payload_object_check', sql`jsonb_typeof(payload) = 'object'`),
  ],
);

export const reviewOutcomes = appSchema.table(
  'review_outcomes',
  {
    agentRunId: bigint('agent_run_id', { mode: 'number' }).primaryKey(),
    organizationId: text('organization_id').notNull(),
    changeRevisionId: bigint('change_revision_id', { mode: 'number' }).notNull(),
    verdict: text().notNull(),
    conclusion: text().notNull(),
    coverageStatus: text('coverage_status').notNull(),
    findingCount: integer('finding_count').notNull(),
    publicationUrl: text('publication_url'),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('review_outcomes_change_revision_idx').on(table.changeRevisionId, table.agentRunId),
    foreignKey({
      columns: [table.agentRunId, table.organizationId],
      foreignColumns: [agentRuns.id, agentRuns.organizationId],
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.changeRevisionId, table.organizationId],
      foreignColumns: [changeRevisions.id, changeRevisions.organizationId],
    }).onDelete('cascade'),
    check(
      'review_outcomes_verdict_check',
      sql`verdict = ANY (ARRAY['approve', 'comment', 'request_changes'])`,
    ),
    check(
      'review_outcomes_conclusion_check',
      sql`conclusion = ANY (ARRAY['ready', 'ready_with_warnings', 'not_ready', 'inconclusive'])`,
    ),
    check(
      'review_outcomes_coverage_status_check',
      sql`coverage_status = ANY (ARRAY['complete', 'incomplete', 'stale'])`,
    ),
    check('review_outcomes_finding_count_check', sql`finding_count >= 0`),
  ],
);

export const repositoryAgents = appSchema.table(
  'repository_agents',
  {
    repositoryId: bigint('repository_id', { mode: 'number' }).notNull(),
    agentId: bigint('agent_id', { mode: 'number' }).notNull(),
    organizationId: text('organization_id').notNull(),
  },
  (table) => [
    index('repository_agents_agent_idx').on(table.agentId),
    foreignKey({
      columns: [table.repositoryId, table.organizationId],
      foreignColumns: [repositories.id, repositories.organizationId],
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.agentId, table.organizationId],
      foreignColumns: [agents.id, agents.organizationId],
    }).onDelete('cascade'),
    primaryKey({ columns: [table.repositoryId, table.agentId] }),
  ],
);

export const repositorySkills = appSchema.table(
  'repository_skills',
  {
    repositoryId: bigint('repository_id', { mode: 'number' }).notNull(),
    skillId: bigint('skill_id', { mode: 'number' }).notNull(),
    organizationId: text('organization_id').notNull(),
  },
  (table) => [
    index('repository_skills_skill_idx').on(table.skillId),
    foreignKey({
      columns: [table.repositoryId, table.organizationId],
      foreignColumns: [repositories.id, repositories.organizationId],
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.skillId, table.organizationId],
      foreignColumns: [skills.id, skills.organizationId],
    }).onDelete('cascade'),
    primaryKey({ columns: [table.repositoryId, table.skillId] }),
  ],
);

export const repositoryIntegrations = appSchema.table(
  'repository_integrations',
  {
    repositoryId: bigint('repository_id', { mode: 'number' }).notNull(),
    integrationId: bigint('integration_id', { mode: 'number' }).notNull(),
    organizationId: text('organization_id').notNull(),
  },
  (table) => [
    index('repository_integrations_integration_idx').on(table.integrationId),
    foreignKey({
      columns: [table.repositoryId, table.organizationId],
      foreignColumns: [repositories.id, repositories.organizationId],
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.integrationId, table.organizationId],
      foreignColumns: [integrations.id, integrations.organizationId],
    }).onDelete('cascade'),
    primaryKey({ columns: [table.repositoryId, table.integrationId] }),
  ],
);

export const agentSkills = appSchema.table(
  'agent_skills',
  {
    agentId: bigint('agent_id', { mode: 'number' }).notNull(),
    skillId: bigint('skill_id', { mode: 'number' }).notNull(),
    organizationId: text('organization_id').notNull(),
  },
  (table) => [
    index('agent_skills_skill_idx').on(table.skillId),
    foreignKey({
      columns: [table.agentId, table.organizationId],
      foreignColumns: [agents.id, agents.organizationId],
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.skillId, table.organizationId],
      foreignColumns: [skills.id, skills.organizationId],
    }).onDelete('cascade'),
    primaryKey({ columns: [table.agentId, table.skillId] }),
  ],
);

export const automationSkills = appSchema.table(
  'automation_skills',
  {
    automationId: bigint('automation_id', { mode: 'number' }).notNull(),
    skillId: bigint('skill_id', { mode: 'number' }).notNull(),
    organizationId: text('organization_id').notNull(),
  },
  (table) => [
    index('automation_skills_skill_idx').on(table.skillId),
    foreignKey({
      columns: [table.automationId, table.organizationId],
      foreignColumns: [automations.id, automations.organizationId],
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.skillId, table.organizationId],
      foreignColumns: [skills.id, skills.organizationId],
    }).onDelete('cascade'),
    primaryKey({ columns: [table.automationId, table.skillId] }),
  ],
);

export const automationIntegrations = appSchema.table(
  'automation_integrations',
  {
    automationId: bigint('automation_id', { mode: 'number' }).notNull(),
    integrationId: bigint('integration_id', { mode: 'number' }).notNull(),
    organizationId: text('organization_id').notNull(),
  },
  (table) => [
    index('automation_integrations_integration_idx').on(table.integrationId),
    foreignKey({
      columns: [table.automationId, table.organizationId],
      foreignColumns: [automations.id, automations.organizationId],
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.integrationId, table.organizationId],
      foreignColumns: [integrations.id, integrations.organizationId],
    }).onDelete('cascade'),
    primaryKey({ columns: [table.automationId, table.integrationId] }),
  ],
);

export const deliveryMessages = appSchema.table(
  'delivery_messages',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
    deliveryId: bigint('delivery_id', { mode: 'number' }).notNull(),
    organizationId: text('organization_id').notNull(),
    authorUserId: text('author_user_id'),
    role: text().notNull(),
    body: text().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('delivery_messages_delivery_idx').on(table.deliveryId, table.id),
    index('delivery_messages_author_idx').on(table.authorUserId),
    foreignKey({
      columns: [table.deliveryId, table.organizationId],
      foreignColumns: [deliveries.id, deliveries.organizationId],
    }).onDelete('cascade'),
    foreignKey({ columns: [table.authorUserId], foreignColumns: [user.id] }).onDelete('set null'),
    check('delivery_messages_role_check', sql`role = ANY (ARRAY['user', 'assistant', 'system'])`),
  ],
);

export const changeComments = appSchema.table(
  'change_comments',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
    changeId: bigint('change_id', { mode: 'number' }).notNull(),
    organizationId: text('organization_id').notNull(),
    externalId: text('external_id'),
    author: text().notNull(),
    body: text().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('change_comments_change_idx').on(table.changeId, table.id),
    foreignKey({
      columns: [table.changeId, table.organizationId],
      foreignColumns: [changes.id, changes.organizationId],
    }).onDelete('cascade'),
    uniqueIndex('change_comments_external_id_unique')
      .on(table.changeId, table.externalId)
      .where(sql`external_id IS NOT NULL`),
  ],
);

export const changeChecks = appSchema.table(
  'change_checks',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
    changeRevisionId: bigint('change_revision_id', { mode: 'number' }).notNull(),
    organizationId: text('organization_id').notNull(),
    name: text().notNull(),
    status: text().notNull(),
    conclusion: text(),
    detailsUrl: text('details_url'),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('change_checks_revision_idx').on(table.changeRevisionId),
    foreignKey({
      columns: [table.changeRevisionId, table.organizationId],
      foreignColumns: [changeRevisions.id, changeRevisions.organizationId],
    }).onDelete('cascade'),
    unique('change_checks_revision_name_unique').on(table.changeRevisionId, table.name),
    check(
      'change_checks_status_check',
      sql`status = ANY (ARRAY['queued', 'running', 'completed'])`,
    ),
  ],
);

export const repositoryRefs = appSchema.table(
  'repository_refs',
  {
    repositoryId: bigint('repository_id', { mode: 'number' }).notNull(),
    organizationId: text('organization_id').notNull(),
    ref: text().notNull(),
    headSha: text('head_sha').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.repositoryId, table.organizationId],
      foreignColumns: [repositories.id, repositories.organizationId],
    }).onDelete('cascade'),
    primaryKey({ columns: [table.repositoryId, table.ref] }),
  ],
);

export const pushSubscriptions = appSchema.table(
  'push_subscriptions',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
    userId: text('user_id').notNull(),
    endpoint: text().notNull(),
    p256dh: text().notNull(),
    auth: text().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('push_subscriptions_user_idx').on(table.userId),
    foreignKey({ columns: [table.userId], foreignColumns: [user.id] }).onDelete('cascade'),
    unique('push_subscriptions_endpoint_unique').on(table.endpoint),
  ],
);
