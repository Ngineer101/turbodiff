import { sql } from 'drizzle-orm';
import type { JsonValue } from '../shared/json.ts';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  primaryKey,
  smallint,
  text,
  time,
  timestamp,
  unique,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

export const appSchema = pgSchema('app');
export const authSchema = pgSchema('auth');
export const nativeEntityIdSeq = appSchema.sequence('native_entity_id_seq', {
  startWith: '4000000000000000',
  increment: '1',
  minValue: '1',
  maxValue: '9007199254740991',
  cache: '1',
  cycle: false,
});
export const factoryVersionSeq = appSchema.sequence('factory_version_seq', {
  startWith: '1',
  increment: '1',
  minValue: '1',
  maxValue: '9223372036854775807',
  cache: '1',
  cycle: false,
});

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
    index('session_active_organization_idx')
      .using('btree', table.activeOrganizationId)
      .where(sql`("activeOrganizationId" IS NOT NULL)`),
    index('session_expires_at_idx').using('btree', table.expiresAt),
    index('session_user_id_idx').using('btree', table.userId),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: 'session_userId_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.activeOrganizationId],
      foreignColumns: [organization.id],
      name: 'session_active_organization_fk',
    }).onDelete('set null'),
    unique('session_token_key').on(table.token),
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
    index('account_user_id_idx').using('btree', table.userId),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: 'account_userId_fkey',
    }).onDelete('cascade'),
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
    index('verification_expires_at_idx').using('btree', table.expiresAt),
    index('verification_identifier_idx').using('btree', table.identifier),
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
    index('oauth_application_user_id_idx').using('btree', table.userId),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: 'oauthApplication_userId_fkey',
    }).onDelete('cascade'),
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
    index('oauth_access_token_client_id_idx').using('btree', table.clientId),
    index('oauth_access_token_expiry_idx').using('btree', table.accessTokenExpiresAt),
    index('oauth_access_token_user_id_idx').using('btree', table.userId),
    foreignKey({
      columns: [table.clientId],
      foreignColumns: [oauthApplication.clientId],
      name: 'oauthAccessToken_clientId_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: 'oauthAccessToken_userId_fkey',
    }).onDelete('cascade'),
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
    index('oauth_consent_client_id_idx').using('btree', table.clientId),
    index('oauth_consent_user_id_idx').using('btree', table.userId),
    foreignKey({
      columns: [table.clientId],
      foreignColumns: [oauthApplication.clientId],
      name: 'oauthConsent_clientId_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: 'oauthConsent_userId_fkey',
    }).onDelete('cascade'),
    unique('oauth_consent_client_user_unique').on(table.clientId, table.userId),
  ],
);

export const installations = appSchema.table(
  'installations',
  {
    id: bigint({ mode: 'number' })
      .default(sql`nextval('app.native_entity_id_seq'::regclass)`)
      .primaryKey()
      .notNull(),
    accountLogin: text('account_login').notNull(),
    accountId: bigint('account_id', { mode: 'number' }).notNull(),
    accountType: text('account_type').notNull(),
    suspended: smallint().default(0).notNull(),
    provider: text().default('github').notNull(),
    installerGithubId: bigint('installer_github_id', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    index('installations_installer_idx')
      .using('btree', table.installerGithubId)
      .where(sql`(installer_github_id IS NOT NULL)`),
    unique('installations_id_provider_unique').on(table.id, table.provider),
    unique('installations_provider_login_unique').on(table.provider, table.accountLogin),
    unique('installations_provider_account_unique').on(table.provider, table.accountId),
    check(
      'installations_account_type_check',
      sql`account_type = ANY (ARRAY['Organization'::text, 'User'::text])`,
    ),
    check('installations_suspended_check', sql`suspended = ANY (ARRAY[0, 1])`),
    check(
      'installations_provider_check',
      sql`provider = ANY (ARRAY['github'::text, 'artifacts'::text])`,
    ),
  ],
);

export const repositories = appSchema.table(
  'repositories',
  {
    id: bigint({ mode: 'number' })
      .default(sql`nextval('app.native_entity_id_seq'::regclass)`)
      .primaryKey()
      .notNull(),
    installationId: bigint('installation_id', { mode: 'number' }).notNull(),
    owner: text().notNull(),
    name: text().notNull(),
    provider: text().default('github').notNull(),
    artifactsRepo: text('artifacts_repo'),
    defaultBranch: text('default_branch'),
    lastPushAt: timestamp('last_push_at', { withTimezone: true, mode: 'string' }),
    enabled: smallint().default(1).notNull(),
    model: text(),
    reviewOnPush: smallint('review_on_push').default(0).notNull(),
    blockingReviews: smallint('blocking_reviews').default(0).notNull(),
    autoFix: smallint('auto_fix').default(0).notNull(),
    checkCommand: text('check_command'),
    runCommand: text('run_command'),
    appPort: integer('app_port'),
    autoMerge: smallint('auto_merge').default(0).notNull(),
    demoVideos: smallint('demo_videos').default(1).notNull(),
    launchable: smallint(),
    autoResolveConflicts: smallint('auto_resolve_conflicts').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    uniqueIndex('repositories_artifacts_repo_unique')
      .using('btree', table.artifactsRepo)
      .where(sql`(artifacts_repo IS NOT NULL)`),
    index('repositories_enabled_idx')
      .using('btree', table.installationId, table.id)
      .where(sql`(enabled = 1)`),
    index('repositories_installation_idx').using(
      'btree',
      table.installationId,
      table.provider,
      table.owner,
      table.name,
    ),
    foreignKey({
      columns: [table.installationId, table.provider],
      foreignColumns: [installations.id, installations.provider],
      name: 'repositories_installation_provider_fk',
    }).onDelete('cascade'),
    unique('repositories_id_installation_unique').on(table.id, table.installationId),
    unique('repositories_owner_name_unique').on(table.owner, table.name),
    check(
      'repositories_provider_check',
      sql`provider = ANY (ARRAY['github'::text, 'artifacts'::text])`,
    ),
    check('repositories_enabled_check', sql`enabled = ANY (ARRAY[0, 1])`),
    check('repositories_review_on_push_check', sql`review_on_push = ANY (ARRAY[0, 1])`),
    check('repositories_blocking_reviews_check', sql`blocking_reviews = ANY (ARRAY[0, 1])`),
    check('repositories_auto_fix_check', sql`auto_fix = ANY (ARRAY[0, 1])`),
    check('repositories_app_port_check', sql`(app_port >= 1) AND (app_port <= 65535)`),
    check('repositories_auto_merge_check', sql`auto_merge = ANY (ARRAY[0, 1])`),
    check('repositories_demo_videos_check', sql`demo_videos = ANY (ARRAY[0, 1])`),
    check('repositories_launchable_check', sql`launchable = ANY (ARRAY[0, 1])`),
    check(
      'repositories_auto_resolve_conflicts_check',
      sql`auto_resolve_conflicts = ANY (ARRAY[0, 1])`,
    ),
    check(
      'repositories_artifacts_shape',
      sql`((provider = 'artifacts'::text) AND (artifacts_repo IS NOT NULL) AND (default_branch IS NOT NULL)) OR ((provider = 'github'::text) AND (artifacts_repo IS NULL))`,
    ),
  ],
);

export const installationRepoSync = appSchema.table(
  'installation_repo_sync',
  {
    installationId: bigint('installation_id', { mode: 'number' }).primaryKey().notNull(),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true, mode: 'string' }),
    syncingUntil: timestamp('syncing_until', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    foreignKey({
      columns: [table.installationId],
      foreignColumns: [installations.id],
      name: 'installation_repo_sync_installation_id_fkey',
    }).onDelete('cascade'),
  ],
);

export const agents = appSchema.table(
  'agents',
  {
    id: bigint({ mode: 'number' })
      .primaryKey()
      .generatedByDefaultAsIdentity({ maxValue: '9007199254740991' }),
    installationId: bigint('installation_id', { mode: 'number' }).notNull(),
    slug: text().notNull(),
    name: text().notNull(),
    description: text(),
    instructions: text().notNull(),
    model: text().default('cloudflare/anthropic/claude-sonnet-5').notNull(),
    isBuiltin: smallint('is_builtin').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.installationId],
      foreignColumns: [installations.id],
      name: 'agents_installation_id_fkey',
    }).onDelete('cascade'),
    unique('agents_id_installation_unique').on(table.id, table.installationId),
    unique('agents_installation_slug_unique').on(table.installationId, table.slug),
    check('agents_is_builtin_check', sql`is_builtin = ANY (ARRAY[0, 1])`),
    check('agents_slug_format', sql`slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'::text`),
  ],
);

export const skills = appSchema.table(
  'skills',
  {
    id: bigint({ mode: 'number' })
      .primaryKey()
      .generatedByDefaultAsIdentity({ maxValue: '9007199254740991' }),
    installationId: bigint('installation_id', { mode: 'number' }).notNull(),
    slug: text().notNull(),
    name: text().notNull(),
    description: text(),
    instructions: text().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.installationId],
      foreignColumns: [installations.id],
      name: 'skills_installation_id_fkey',
    }).onDelete('cascade'),
    unique('skills_id_installation_unique').on(table.id, table.installationId),
    unique('skills_installation_slug_unique').on(table.installationId, table.slug),
    check('skills_slug_format', sql`slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'::text`),
  ],
);

export const connections = appSchema.table(
  'connections',
  {
    id: bigint({ mode: 'number' })
      .primaryKey()
      .generatedByDefaultAsIdentity({ maxValue: '9007199254740991' }),
    installationId: bigint('installation_id', { mode: 'number' }).notNull(),
    name: text().notNull(),
    kind: text().default('mcp').notNull(),
    url: text().notNull(),
    toolAllowlist: jsonb('tool_allowlist').$type<JsonValue>(),
    authCiphertext: text('auth_ciphertext'),
    optional: smallint().default(1).notNull(),
    authType: text('auth_type').default('none').notNull(),
    authConfigCiphertext: text('auth_config_ciphertext'),
    oauthTokenExpiresAt: timestamp('oauth_token_expires_at', {
      withTimezone: true,
      mode: 'string',
    }),
    oauthNeedsReauth: smallint('oauth_needs_reauth').default(0).notNull(),
    oauthHasRefreshToken: smallint('oauth_has_refresh_token').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.installationId],
      foreignColumns: [installations.id],
      name: 'connections_installation_id_fkey',
    }).onDelete('cascade'),
    unique('connections_id_installation_unique').on(table.id, table.installationId),
    unique('connections_installation_name_unique').on(table.installationId, table.name),
    check('connections_kind_check', sql`kind = ANY (ARRAY['mcp'::text, 'api'::text])`),
    check('connections_optional_check', sql`optional = ANY (ARRAY[0, 1])`),
    check(
      'connections_auth_type_check',
      sql`auth_type = ANY (ARRAY['none'::text, 'bearer'::text, 'api_key'::text, 'client_credentials'::text, 'oauth'::text])`,
    ),
    check('connections_oauth_needs_reauth_check', sql`oauth_needs_reauth = ANY (ARRAY[0, 1])`),
    check(
      'connections_oauth_has_refresh_token_check',
      sql`oauth_has_refresh_token = ANY (ARRAY[0, 1])`,
    ),
  ],
);

export const todos = appSchema.table(
  'todos',
  {
    id: bigint({ mode: 'number' })
      .primaryKey()
      .generatedByDefaultAsIdentity({ maxValue: '9007199254740991' }),
    installationId: bigint('installation_id', { mode: 'number' }).notNull(),
    title: text().notNull(),
    notes: text(),
    createdByLogin: text('created_by_login'),
    createdById: bigint('created_by_id', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    planId: bigint('plan_id', { mode: 'number' }).references((): AnyPgColumn => plans.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    index('todos_installation_unplanned_idx')
      .using('btree', table.installationId, table.id.desc())
      .where(sql`(plan_id IS NULL)`),
    uniqueIndex('todos_plan_unique')
      .using('btree', table.planId)
      .where(sql`(plan_id IS NOT NULL)`),
    foreignKey({
      columns: [table.installationId],
      foreignColumns: [installations.id],
      name: 'todos_installation_id_fkey',
    }).onDelete('cascade'),
  ],
);

export const plans = appSchema.table(
  'plans',
  {
    id: bigint({ mode: 'number' })
      .primaryKey()
      .generatedByDefaultAsIdentity({ maxValue: '9007199254740991' }),
    repositoryId: bigint('repository_id', { mode: 'number' }).notNull(),
    todoId: bigint('todo_id', { mode: 'number' }).references((): AnyPgColumn => todos.id, {
      onDelete: 'set null',
    }),
    title: text().notNull(),
    requirements: text().notNull(),
    analysis: text(),
    questions: jsonb().$type<JsonValue>(),
    answers: jsonb().$type<JsonValue>(),
    plan: text(),
    acceptance: jsonb().$type<JsonValue>(),
    status: text().default('analyzing').notNull(),
    error: text(),
    createdByLogin: text('created_by_login'),
    createdById: bigint('created_by_id', { mode: 'number' }),
    tier: text(),
    archived: smallint().default(0).notNull(),
    feedback: text(),
    attachments: jsonb().$type<JsonValue>(),
    runnerModel: text('runner_model'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    featureId: bigint('feature_id', { mode: 'number' }).references((): AnyPgColumn => features.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    index('plans_active_idx')
      .using('btree', table.repositoryId, table.id.desc())
      .where(sql`(archived = 0)`),
    index('plans_feature_idx')
      .using('btree', table.featureId)
      .where(sql`(feature_id IS NOT NULL)`),
    index('plans_repository_created_idx').using(
      'btree',
      table.repositoryId,
      table.createdAt.desc(),
    ),
    foreignKey({
      columns: [table.repositoryId],
      foreignColumns: [repositories.id],
      name: 'plans_repository_id_fkey',
    }).onDelete('cascade'),
    unique('plans_todo_unique').on(table.todoId),
    check(
      'plans_status_check',
      sql`status = ANY (ARRAY['analyzing'::text, 'awaiting_answers'::text, 'refining'::text, 'plan_ready'::text, 'approving'::text, 'approved'::text, 'failed'::text])`,
    ),
    check('plans_archived_check', sql`archived = ANY (ARRAY[0, 1])`),
  ],
);

export const features = appSchema.table(
  'features',
  {
    id: bigint({ mode: 'number' })
      .primaryKey()
      .generatedByDefaultAsIdentity({ maxValue: '9007199254740991' }),
    repositoryId: bigint('repository_id', { mode: 'number' }).notNull(),
    planId: bigint('plan_id', { mode: 'number' }).references((): AnyPgColumn => plans.id, {
      onDelete: 'set null',
    }),
    title: text().notNull(),
    spec: text().notNull(),
    acceptance: jsonb().$type<JsonValue>(),
    branch: text(),
    prNumber: integer('pr_number'),
    status: text().default('queued').notNull(),
    error: text(),
    authorLogin: text('author_login'),
    authorId: bigint('author_id', { mode: 'number' }),
    coauthorLogin: text('coauthor_login'),
    coauthorId: bigint('coauthor_id', { mode: 'number' }),
    runStartedAt: timestamp('run_started_at', { withTimezone: true, mode: 'string' }),
    tier: text(),
    inputTokens: bigint('input_tokens', { mode: 'number' }).default(0).notNull(),
    outputTokens: bigint('output_tokens', { mode: 'number' }).default(0).notNull(),
    cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' }).default(0).notNull(),
    cacheWriteTokens: bigint('cache_write_tokens', { mode: 'number' }).default(0).notNull(),
    costUsd: numeric('cost_usd', { precision: 20, scale: 10, mode: 'number' }).default(0).notNull(),
    model: text(),
    runnerModel: text('runner_model'),
    changeRequestId: bigint('change_request_id', { mode: 'number' }).references(
      (): AnyPgColumn => changeRequests.id,
      { onDelete: 'set null' },
    ),
    criteriaConflict: smallint('criteria_conflict').default(0).notNull(),
    acceptanceUpdatedAt: timestamp('acceptance_updated_at', { withTimezone: true, mode: 'string' }),
    proposedAcceptance: jsonb('proposed_acceptance').$type<JsonValue>(),
    chatSessionId: text('chat_session_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    index('features_change_request_idx')
      .using('btree', table.changeRequestId)
      .where(sql`(change_request_id IS NOT NULL)`),
    index('features_generating_created_idx')
      .using('btree', table.createdAt)
      .where(sql`(status = 'generating'::text)`),
    index('features_open_pr_idx')
      .using('btree', table.repositoryId, table.prNumber)
      .where(sql`((status = 'pr_opened'::text) AND (pr_number IS NOT NULL))`),
    index('features_plan_idx')
      .using('btree', table.planId)
      .where(sql`(plan_id IS NOT NULL)`),
    index('features_repository_created_idx').using('btree', table.repositoryId, table.id.desc()),
    index('features_repository_pr_idx')
      .using('btree', table.repositoryId, table.prNumber, table.id.desc())
      .where(sql`(pr_number IS NOT NULL)`),
    foreignKey({
      columns: [table.repositoryId],
      foreignColumns: [repositories.id],
      name: 'features_repository_id_fkey',
    }).onDelete('cascade'),
    unique('features_plan_repository_unique').on(table.planId, table.repositoryId),
    check('features_pr_number_check', sql`pr_number > 0`),
    check(
      'features_status_check',
      sql`status = ANY (ARRAY['queued'::text, 'generating'::text, 'pr_opened'::text, 'no_changes'::text, 'checks_failed'::text, 'failed'::text, 'merged'::text, 'pr_closed'::text, 'abandoned'::text])`,
    ),
    check('features_input_tokens_check', sql`input_tokens >= 0`),
    check('features_output_tokens_check', sql`output_tokens >= 0`),
    check('features_cache_read_tokens_check', sql`cache_read_tokens >= 0`),
    check('features_cache_write_tokens_check', sql`cache_write_tokens >= 0`),
    check('features_cost_usd_check', sql`cost_usd >= (0)::numeric`),
    check('features_criteria_conflict_check', sql`criteria_conflict = ANY (ARRAY[0, 1])`),
  ],
);

export const reviews = appSchema.table(
  'reviews',
  {
    id: bigint({ mode: 'number' })
      .primaryKey()
      .generatedByDefaultAsIdentity({ maxValue: '9007199254740991' }),
    repositoryId: bigint('repository_id', { mode: 'number' }).notNull(),
    installationId: bigint('installation_id', { mode: 'number' }).notNull(),
    prNumber: integer('pr_number').notNull(),
    triggerEvent: text('trigger_event').notNull(),
    status: text().default('completed').notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'string' }),
    reviewUrl: text('review_url'),
    inputTokens: bigint('input_tokens', { mode: 'number' }).default(0).notNull(),
    outputTokens: bigint('output_tokens', { mode: 'number' }).default(0).notNull(),
    cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' }).default(0).notNull(),
    cacheWriteTokens: bigint('cache_write_tokens', { mode: 'number' }).default(0).notNull(),
    costUsd: numeric('cost_usd', { precision: 20, scale: 10, mode: 'number' }).default(0).notNull(),
    model: text(),
    agentSlug: text('agent_slug'),
    agentInstanceId: text('agent_instance_id'),
    riskTier: text('risk_tier'),
    findingsCount: integer('findings_count'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    index('reviews_agent_instance_idx').using('btree', table.agentInstanceId),
    index('reviews_installation_time_idx').using(
      'btree',
      table.installationId,
      table.createdAt.desc(),
    ),
    uniqueIndex('reviews_one_running_instance_idx')
      .using('btree', table.agentInstanceId)
      .where(sql`((status = 'running'::text) AND (agent_instance_id IS NOT NULL))`),
    index('reviews_repo_pr_idx').using(
      'btree',
      table.repositoryId,
      table.prNumber,
      table.id.desc(),
    ),
    index('reviews_repository_installation_idx').using(
      'btree',
      table.repositoryId,
      table.installationId,
    ),
    index('reviews_running_installation_idx')
      .using('btree', table.installationId, table.createdAt)
      .where(sql`(status = 'running'::text)`),
    foreignKey({
      columns: [table.repositoryId, table.installationId],
      foreignColumns: [repositories.id, repositories.installationId],
      name: 'reviews_repository_tenant_fk',
    }).onDelete('cascade'),
    check('reviews_output_tokens_check', sql`output_tokens >= 0`),
    check('reviews_cache_read_tokens_check', sql`cache_read_tokens >= 0`),
    check('reviews_cache_write_tokens_check', sql`cache_write_tokens >= 0`),
    check('reviews_pr_number_check', sql`pr_number > 0`),
    check(
      'reviews_status_check',
      sql`status = ANY (ARRAY['running'::text, 'completed'::text, 'failed'::text])`,
    ),
    check('reviews_input_tokens_check', sql`input_tokens >= 0`),
    check('reviews_cost_usd_check', sql`cost_usd >= (0)::numeric`),
    check(
      'reviews_risk_tier_check',
      sql`(risk_tier IS NULL) OR (risk_tier = ANY (ARRAY['trivial'::text, 'lite'::text, 'full'::text]))`,
    ),
    check('reviews_findings_count_check', sql`(findings_count IS NULL) OR (findings_count >= 0)`),
    check(
      'reviews_completion_shape',
      sql`((status = 'running'::text) AND (completed_at IS NULL)) OR (status <> 'running'::text)`,
    ),
  ],
);

export const fixAttempts = appSchema.table(
  'fix_attempts',
  {
    id: bigint({ mode: 'number' })
      .primaryKey()
      .generatedByDefaultAsIdentity({ maxValue: '9007199254740991' }),
    repositoryId: bigint('repository_id', { mode: 'number' }).notNull(),
    prNumber: integer('pr_number').notNull(),
    trigger: text().notNull(),
    status: text().default('running').notNull(),
    commitSha: text('commit_sha'),
    error: text(),
    inputTokens: bigint('input_tokens', { mode: 'number' }).default(0).notNull(),
    outputTokens: bigint('output_tokens', { mode: 'number' }).default(0).notNull(),
    cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' }).default(0).notNull(),
    cacheWriteTokens: bigint('cache_write_tokens', { mode: 'number' }).default(0).notNull(),
    costUsd: numeric('cost_usd', { precision: 20, scale: 10, mode: 'number' }).default(0).notNull(),
    model: text(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    uniqueIndex('fix_attempts_one_running_idx')
      .using('btree', table.repositoryId, table.prNumber)
      .where(sql`(status = 'running'::text)`),
    index('fix_attempts_pr_idx').using(
      'btree',
      table.repositoryId,
      table.prNumber,
      table.id.desc(),
    ),
    foreignKey({
      columns: [table.repositoryId],
      foreignColumns: [repositories.id],
      name: 'fix_attempts_repository_id_fkey',
    }).onDelete('cascade'),
    check('fix_attempts_pr_number_check', sql`pr_number > 0`),
    check(
      'fix_attempts_status_check',
      sql`status = ANY (ARRAY['running'::text, 'fixed'::text, 'no_changes'::text, 'tests_failed'::text, 'failed'::text])`,
    ),
    check('fix_attempts_input_tokens_check', sql`input_tokens >= 0`),
    check('fix_attempts_output_tokens_check', sql`output_tokens >= 0`),
    check('fix_attempts_cache_read_tokens_check', sql`cache_read_tokens >= 0`),
    check('fix_attempts_cache_write_tokens_check', sql`cache_write_tokens >= 0`),
    check('fix_attempts_cost_usd_check', sql`cost_usd >= (0)::numeric`),
  ],
);

export const verifications = appSchema.table(
  'verifications',
  {
    id: bigint({ mode: 'number' })
      .primaryKey()
      .generatedByDefaultAsIdentity({ maxValue: '9007199254740991' }),
    featureId: bigint('feature_id', { mode: 'number' }).notNull(),
    status: text().default('running').notNull(),
    results: jsonb().$type<JsonValue>(),
    summary: text(),
    error: text(),
    demo: jsonb().$type<JsonValue>(),
    inputTokens: bigint('input_tokens', { mode: 'number' }).default(0).notNull(),
    outputTokens: bigint('output_tokens', { mode: 'number' }).default(0).notNull(),
    cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' }).default(0).notNull(),
    cacheWriteTokens: bigint('cache_write_tokens', { mode: 'number' }).default(0).notNull(),
    costUsd: numeric('cost_usd', { precision: 20, scale: 10, mode: 'number' }).default(0).notNull(),
    model: text(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    index('verifications_feature_idx').using('btree', table.featureId, table.id.desc()),
    uniqueIndex('verifications_one_running_idx')
      .using('btree', table.featureId)
      .where(sql`(status = 'running'::text)`),
    index('verifications_running_created_idx')
      .using('btree', table.createdAt)
      .where(sql`(status = 'running'::text)`),
    foreignKey({
      columns: [table.featureId],
      foreignColumns: [features.id],
      name: 'verifications_feature_id_fkey',
    }).onDelete('cascade'),
    check(
      'verifications_status_check',
      sql`status = ANY (ARRAY['running'::text, 'passed'::text, 'failed'::text, 'error'::text, 'skipped'::text])`,
    ),
    check('verifications_input_tokens_check', sql`input_tokens >= 0`),
    check('verifications_output_tokens_check', sql`output_tokens >= 0`),
    check('verifications_cache_read_tokens_check', sql`cache_read_tokens >= 0`),
    check('verifications_cache_write_tokens_check', sql`cache_write_tokens >= 0`),
    check('verifications_cost_usd_check', sql`cost_usd >= (0)::numeric`),
  ],
);

export const cockpitComments = appSchema.table(
  'cockpit_comments',
  {
    id: bigint({ mode: 'number' })
      .primaryKey()
      .generatedByDefaultAsIdentity({ maxValue: '9007199254740991' }),
    featureId: bigint('feature_id', { mode: 'number' }).notNull(),
    path: text().notNull(),
    line: integer().notNull(),
    side: text().default('additions').notNull(),
    body: text().notNull(),
    author: text().notNull(),
    authorId: bigint('author_id', { mode: 'number' }),
    status: text().default('open').notNull(),
    fixAttemptId: bigint('fix_attempt_id', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    index('cockpit_comments_feature_idx').using('btree', table.featureId, table.id),
    index('cockpit_comments_fix_attempt_idx')
      .using('btree', table.fixAttemptId)
      .where(sql`(fix_attempt_id IS NOT NULL)`),
    foreignKey({
      columns: [table.featureId],
      foreignColumns: [features.id],
      name: 'cockpit_comments_feature_id_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.fixAttemptId],
      foreignColumns: [fixAttempts.id],
      name: 'cockpit_comments_fix_attempt_id_fkey',
    }).onDelete('set null'),
    check('cockpit_comments_line_check', sql`line > 0`),
    check(
      'cockpit_comments_side_check',
      sql`side = ANY (ARRAY['additions'::text, 'deletions'::text])`,
    ),
    check(
      'cockpit_comments_status_check',
      sql`status = ANY (ARRAY['open'::text, 'dispatched'::text])`,
    ),
  ],
);

export const chatMessages = appSchema.table(
  'chat_messages',
  {
    id: bigint({ mode: 'number' })
      .primaryKey()
      .generatedByDefaultAsIdentity({ maxValue: '9007199254740991' }),
    featureId: bigint('feature_id', { mode: 'number' }).notNull(),
    role: text().notNull(),
    body: text().notNull(),
    author: text(),
    authorId: bigint('author_id', { mode: 'number' }),
    status: text().default('done').notNull(),
    outcome: text(),
    commitSha: text('commit_sha'),
    error: text(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    index('chat_messages_feature_idx').using('btree', table.featureId, table.id),
    uniqueIndex('chat_messages_one_pending_user_idx')
      .using('btree', table.featureId)
      .where(
        sql`((role = 'user'::text) AND (status = ANY (ARRAY['queued'::text, 'running'::text])))`,
      ),
    foreignKey({
      columns: [table.featureId],
      foreignColumns: [features.id],
      name: 'chat_messages_feature_id_fkey',
    }).onDelete('cascade'),
    check('chat_messages_role_check', sql`role = ANY (ARRAY['user'::text, 'assistant'::text])`),
    check(
      'chat_messages_status_check',
      sql`status = ANY (ARRAY['queued'::text, 'running'::text, 'done'::text, 'failed'::text])`,
    ),
    check(
      'chat_messages_outcome_check',
      sql`(outcome IS NULL) OR (outcome = ANY (ARRAY['changed'::text, 'no_changes'::text, 'tests_failed'::text]))`,
    ),
  ],
);

export const automations = appSchema.table(
  'automations',
  {
    id: bigint({ mode: 'number' })
      .primaryKey()
      .generatedByDefaultAsIdentity({ maxValue: '9007199254740991' }),
    repositoryId: bigint('repository_id', { mode: 'number' }).notNull(),
    name: text().notNull(),
    prompt: text().notNull(),
    scheduleKind: text('schedule_kind').notNull(),
    timeOfDay: time('time_of_day'),
    dayOfWeek: smallint('day_of_week'),
    enabled: smallint().default(1).notNull(),
    nextRunAt: timestamp('next_run_at', { withTimezone: true, mode: 'string' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    index('automations_due_idx')
      .using('btree', table.nextRunAt)
      .where(sql`(enabled = 1)`),
    index('automations_repository_idx').using('btree', table.repositoryId, table.id),
    foreignKey({
      columns: [table.repositoryId],
      foreignColumns: [repositories.id],
      name: 'automations_repository_id_fkey',
    }).onDelete('cascade'),
    check(
      'automations_schedule_kind_check',
      sql`schedule_kind = ANY (ARRAY['hourly'::text, 'daily'::text, 'weekly'::text])`,
    ),
    check('automations_day_of_week_check', sql`(day_of_week >= 0) AND (day_of_week <= 6)`),
    check('automations_enabled_check', sql`enabled = ANY (ARRAY[0, 1])`),
    check(
      'automations_schedule_shape',
      sql`((schedule_kind = 'hourly'::text) AND (time_of_day IS NULL) AND (day_of_week IS NULL)) OR ((schedule_kind = 'daily'::text) AND (time_of_day IS NOT NULL) AND (day_of_week IS NULL)) OR ((schedule_kind = 'weekly'::text) AND (time_of_day IS NOT NULL) AND (day_of_week IS NOT NULL))`,
    ),
  ],
);

export const automationRuns = appSchema.table(
  'automation_runs',
  {
    id: bigint({ mode: 'number' })
      .primaryKey()
      .generatedByDefaultAsIdentity({ maxValue: '9007199254740991' }),
    automationId: bigint('automation_id', { mode: 'number' }).notNull(),
    status: text().default('running').notNull(),
    prNumber: integer('pr_number'),
    commitSha: text('commit_sha'),
    error: text(),
    inputTokens: bigint('input_tokens', { mode: 'number' }).default(0).notNull(),
    outputTokens: bigint('output_tokens', { mode: 'number' }).default(0).notNull(),
    cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' }).default(0).notNull(),
    cacheWriteTokens: bigint('cache_write_tokens', { mode: 'number' }).default(0).notNull(),
    costUsd: numeric('cost_usd', { precision: 20, scale: 10, mode: 'number' }).default(0).notNull(),
    model: text(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    index('automation_runs_automation_idx').using(
      'btree',
      table.automationId,
      table.createdAt.desc(),
    ),
    uniqueIndex('automation_runs_one_running_idx')
      .using('btree', table.automationId)
      .where(sql`(status = 'running'::text)`),
    foreignKey({
      columns: [table.automationId],
      foreignColumns: [automations.id],
      name: 'automation_runs_automation_id_fkey',
    }).onDelete('cascade'),
    check(
      'automation_runs_status_check',
      sql`status = ANY (ARRAY['running'::text, 'pr_opened'::text, 'no_changes'::text, 'checks_failed'::text, 'failed'::text])`,
    ),
    check('automation_runs_pr_number_check', sql`(pr_number IS NULL) OR (pr_number > 0)`),
    check('automation_runs_input_tokens_check', sql`input_tokens >= 0`),
    check('automation_runs_output_tokens_check', sql`output_tokens >= 0`),
    check('automation_runs_cache_read_tokens_check', sql`cache_read_tokens >= 0`),
    check('automation_runs_cache_write_tokens_check', sql`cache_write_tokens >= 0`),
    check('automation_runs_cost_usd_check', sql`cost_usd >= (0)::numeric`),
  ],
);

export const agentRuns = appSchema.table(
  'agent_runs',
  {
    id: bigint({ mode: 'number' })
      .primaryKey()
      .generatedByDefaultAsIdentity({ maxValue: '9007199254740991' }),
    kind: text().notNull(),
    planId: bigint('plan_id', { mode: 'number' }),
    featureId: bigint('feature_id', { mode: 'number' }),
    fixAttemptId: bigint('fix_attempt_id', { mode: 'number' }),
    automationRunId: bigint('automation_run_id', { mode: 'number' }),
    logKey: text('log_key').notNull(),
    success: smallint().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    index('agent_runs_automation_idx')
      .using('btree', table.automationRunId)
      .where(sql`(automation_run_id IS NOT NULL)`),
    index('agent_runs_feature_idx')
      .using('btree', table.featureId)
      .where(sql`(feature_id IS NOT NULL)`),
    index('agent_runs_fix_attempt_idx')
      .using('btree', table.fixAttemptId)
      .where(sql`(fix_attempt_id IS NOT NULL)`),
    index('agent_runs_plan_idx')
      .using('btree', table.planId)
      .where(sql`(plan_id IS NOT NULL)`),
    foreignKey({
      columns: [table.planId],
      foreignColumns: [plans.id],
      name: 'agent_runs_plan_id_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.featureId],
      foreignColumns: [features.id],
      name: 'agent_runs_feature_id_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.fixAttemptId],
      foreignColumns: [fixAttempts.id],
      name: 'agent_runs_fix_attempt_id_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.automationRunId],
      foreignColumns: [automationRuns.id],
      name: 'agent_runs_automation_run_id_fkey',
    }).onDelete('cascade'),
    check(
      'agent_runs_kind_check',
      sql`kind = ANY (ARRAY['plan_analyze'::text, 'plan_refine'::text, 'generate'::text, 'verify'::text, 'fix'::text, 'automation'::text, 'chat'::text, 'resolve_conflict'::text])`,
    ),
    check('agent_runs_success_check', sql`success = ANY (ARRAY[0, 1])`),
    check(
      'agent_runs_owner',
      sql`num_nonnulls(plan_id, feature_id, fix_attempt_id, automation_run_id) >= 1`,
    ),
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
    installationId: bigint({ mode: 'number' }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.installationId],
      foreignColumns: [installations.id],
      name: 'organization_installationId_fkey',
    }).onDelete('cascade'),
    unique('organization_slug_key').on(table.slug),
    unique('organization_installationId_key').on(table.installationId),
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
    index('member_user_id_idx').using('btree', table.userId),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'member_organizationId_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: 'member_userId_fkey',
    }).onDelete('cascade'),
    unique('member_organization_user_unique').on(table.organizationId, table.userId),
    check(
      'member_role_check',
      sql`role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text])`,
    ),
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
    index('invitation_email_status_idx').using('btree', table.email, table.status),
    index('invitation_inviter_idx').using('btree', table.inviterId),
    index('invitation_organization_idx').using('btree', table.organizationId, table.status),
    uniqueIndex('invitation_pending_email_unique')
      .using('btree', table.organizationId, sql`lower(${table.email})`)
      .where(sql`(status = 'pending'::text)`),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: 'invitation_organizationId_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.inviterId],
      foreignColumns: [user.id],
      name: 'invitation_inviterId_fkey',
    }).onDelete('cascade'),
    check(
      'invitation_role_check',
      sql`role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text])`,
    ),
    check(
      'invitation_status_check',
      sql`status = ANY (ARRAY['pending'::text, 'accepted'::text, 'rejected'::text, 'canceled'::text])`,
    ),
  ],
);

export const userTokens = appSchema.table('user_tokens', {
  userId: bigint('user_id', { mode: 'number' }).primaryKey().notNull(),
  login: text().notNull(),
  refreshCiphertext: text('refresh_ciphertext').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
});

export const userInstallationAccess = appSchema.table(
  'user_installation_access',
  {
    userId: text('user_id').primaryKey().notNull(),
    installationIds: bigint('installation_ids', { mode: 'number' }).array().default([]).notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: 'user_installation_access_user_id_fkey',
    }).onDelete('cascade'),
    check(
      'user_installation_access_no_null_ids',
      sql`array_position(installation_ids, NULL::bigint) IS NULL`,
    ),
  ],
);

export const pushSubscriptions = appSchema.table(
  'push_subscriptions',
  {
    id: bigint({ mode: 'number' })
      .primaryKey()
      .generatedByDefaultAsIdentity({ maxValue: '9007199254740991' }),
    userGithubId: bigint('user_github_id', { mode: 'number' }).notNull(),
    endpoint: text().notNull(),
    p256Dh: text().notNull(),
    auth: text().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    index('push_subscriptions_user_idx').using('btree', table.userGithubId),
    foreignKey({
      columns: [table.userGithubId],
      foreignColumns: [user.githubId],
      name: 'push_subscriptions_user_github_id_fkey',
    }).onDelete('cascade'),
    unique('push_subscriptions_endpoint_key').on(table.endpoint),
  ],
);

export const changeRequestCounters = appSchema.table(
  'change_request_counters',
  {
    repositoryId: bigint('repository_id', { mode: 'number' }).primaryKey().notNull(),
    lastNumber: integer('last_number').notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.repositoryId],
      foreignColumns: [repositories.id],
      name: 'change_request_counters_repository_id_fkey',
    }).onDelete('cascade'),
    check('change_request_counters_last_number_check', sql`last_number > 0`),
  ],
);

export const changeRequests = appSchema.table(
  'change_requests',
  {
    id: bigint({ mode: 'number' })
      .primaryKey()
      .generatedByDefaultAsIdentity({ maxValue: '9007199254740991' }),
    repositoryId: bigint('repository_id', { mode: 'number' }).notNull(),
    number: integer().notNull(),
    featureId: bigint('feature_id', { mode: 'number' }).references((): AnyPgColumn => features.id, {
      onDelete: 'set null',
    }),
    title: text().notNull(),
    sourceBranch: text('source_branch').notNull(),
    targetBranch: text('target_branch').notNull(),
    status: text().default('open').notNull(),
    sourceHead: text('source_head'),
    targetHead: text('target_head'),
    mergeBase: text('merge_base'),
    mergeable: smallint(),
    conflictFiles: jsonb('conflict_files').$type<JsonValue>(),
    files: jsonb().$type<JsonValue>(),
    diffKey: text('diff_key'),
    patchTruncated: smallint('patch_truncated').default(0).notNull(),
    reviewStatus: text('review_status'),
    mergedHead: text('merged_head'),
    openedBy: text('opened_by').default('factory').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    index('change_requests_feature_idx')
      .using('btree', table.featureId)
      .where(sql`(feature_id IS NOT NULL)`),
    uniqueIndex('change_requests_open_branches_unique')
      .using('btree', table.repositoryId, table.sourceBranch, table.targetBranch)
      .where(sql`(status = 'open'::text)`),
    index('change_requests_repo_status_idx').using(
      'btree',
      table.repositoryId,
      table.status,
      table.number.desc(),
    ),
    foreignKey({
      columns: [table.repositoryId],
      foreignColumns: [repositories.id],
      name: 'change_requests_repository_id_fkey',
    }).onDelete('cascade'),
    unique('change_requests_repo_number_unique').on(table.repositoryId, table.number),
    check('change_requests_number_check', sql`number > 0`),
    check(
      'change_requests_status_check',
      sql`status = ANY (ARRAY['open'::text, 'merged'::text, 'closed'::text])`,
    ),
    check('change_requests_mergeable_check', sql`mergeable = ANY (ARRAY[0, 1])`),
    check('change_requests_patch_truncated_check', sql`patch_truncated = ANY (ARRAY[0, 1])`),
    check(
      'change_requests_review_status_check',
      sql`(review_status IS NULL) OR (review_status = ANY (ARRAY['approved'::text, 'changes_requested'::text]))`,
    ),
  ],
);

export const crComments = appSchema.table(
  'cr_comments',
  {
    id: bigint({ mode: 'number' })
      .primaryKey()
      .generatedByDefaultAsIdentity({ maxValue: '9007199254740991' }),
    changeRequestId: bigint('change_request_id', { mode: 'number' }).notNull(),
    file: text(),
    line: integer(),
    author: text().notNull(),
    kind: text().default('comment').notNull(),
    severity: text(),
    body: text().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    index('cr_comments_change_request_idx').using('btree', table.changeRequestId, table.id),
    foreignKey({
      columns: [table.changeRequestId],
      foreignColumns: [changeRequests.id],
      name: 'cr_comments_change_request_id_fkey',
    }).onDelete('cascade'),
    check('cr_comments_line_check', sql`(line IS NULL) OR (line > 0)`),
    check(
      'cr_comments_kind_check',
      sql`kind = ANY (ARRAY['comment'::text, 'finding'::text, 'summary'::text])`,
    ),
    check(
      'cr_comments_severity_check',
      sql`(severity IS NULL) OR (severity = ANY (ARRAY['P1'::text, 'P2'::text, 'P3'::text]))`,
    ),
    check('cr_comments_location', sql`((file IS NULL) AND (line IS NULL)) OR (file IS NOT NULL)`),
  ],
);

export const crChecks = appSchema.table(
  'cr_checks',
  {
    id: bigint({ mode: 'number' })
      .primaryKey()
      .generatedByDefaultAsIdentity({ maxValue: '9007199254740991' }),
    changeRequestId: bigint('change_request_id', { mode: 'number' }).notNull(),
    name: text().notNull(),
    status: text().notNull(),
    summary: text(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.changeRequestId],
      foreignColumns: [changeRequests.id],
      name: 'cr_checks_change_request_id_fkey',
    }).onDelete('cascade'),
    unique('cr_checks_name_unique').on(table.changeRequestId, table.name),
    check(
      'cr_checks_status_check',
      sql`status = ANY (ARRAY['running'::text, 'passed'::text, 'failed'::text, 'error'::text])`,
    ),
  ],
);

export const todoRepositories = appSchema.table(
  'todo_repositories',
  {
    todoId: bigint('todo_id', { mode: 'number' }).notNull(),
    repositoryId: bigint('repository_id', { mode: 'number' }).notNull(),
    position: smallint().notNull(),
  },
  (table) => [
    index('todo_repositories_repository_idx').using('btree', table.repositoryId),
    foreignKey({
      columns: [table.todoId],
      foreignColumns: [todos.id],
      name: 'todo_repositories_todo_id_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.repositoryId],
      foreignColumns: [repositories.id],
      name: 'todo_repositories_repository_id_fkey',
    }).onDelete('cascade'),
    primaryKey({ columns: [table.todoId, table.repositoryId], name: 'todo_repositories_pkey' }),
    unique('todo_repositories_position_unique').on(table.todoId, table.position),
    check('todo_repositories_position_check', sql`("position" >= 0) AND ("position" <= 2)`),
  ],
);

export const planRepositories = appSchema.table(
  'plan_repositories',
  {
    planId: bigint('plan_id', { mode: 'number' }).notNull(),
    repositoryId: bigint('repository_id', { mode: 'number' }).notNull(),
    position: smallint().notNull(),
  },
  (table) => [
    index('plan_repositories_repository_idx').using('btree', table.repositoryId),
    foreignKey({
      columns: [table.planId],
      foreignColumns: [plans.id],
      name: 'plan_repositories_plan_id_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.repositoryId],
      foreignColumns: [repositories.id],
      name: 'plan_repositories_repository_id_fkey',
    }).onDelete('cascade'),
    primaryKey({ columns: [table.planId, table.repositoryId], name: 'plan_repositories_pkey' }),
    unique('plan_repositories_position_unique').on(table.planId, table.position),
    check('plan_repositories_position_check', sql`("position" >= 0) AND ("position" <= 2)`),
  ],
);

export const repositoryRefs = appSchema.table(
  'repository_refs',
  {
    repositoryId: bigint('repository_id', { mode: 'number' }).notNull(),
    ref: text().notNull(),
    headSha: text('head_sha').notNull(),
    pushedAt: timestamp('pushed_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    index('repository_refs_head_idx').using('btree', table.repositoryId, table.headSha),
    foreignKey({
      columns: [table.repositoryId],
      foreignColumns: [repositories.id],
      name: 'repository_refs_repository_id_fkey',
    }).onDelete('cascade'),
    primaryKey({ columns: [table.repositoryId, table.ref], name: 'repository_refs_pkey' }),
  ],
);

export const repoAgents = appSchema.table(
  'repo_agents',
  {
    repositoryId: bigint('repository_id', { mode: 'number' }).notNull(),
    agentId: bigint('agent_id', { mode: 'number' }).notNull(),
    installationId: bigint('installation_id', { mode: 'number' }).notNull(),
    enabled: smallint().default(1).notNull(),
  },
  (table) => [
    index('repo_agents_agent_tenant_idx').using('btree', table.agentId, table.installationId),
    index('repo_agents_repository_tenant_idx').using(
      'btree',
      table.repositoryId,
      table.installationId,
    ),
    foreignKey({
      columns: [table.repositoryId, table.installationId],
      foreignColumns: [repositories.id, repositories.installationId],
      name: 'repo_agents_repository_tenant_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.agentId, table.installationId],
      foreignColumns: [agents.id, agents.installationId],
      name: 'repo_agents_agent_tenant_fk',
    }).onDelete('cascade'),
    primaryKey({ columns: [table.repositoryId, table.agentId], name: 'repo_agents_pkey' }),
    check('repo_agents_enabled_check', sql`enabled = ANY (ARRAY[0, 1])`),
  ],
);

export const repoSkills = appSchema.table(
  'repo_skills',
  {
    repositoryId: bigint('repository_id', { mode: 'number' }).notNull(),
    skillId: bigint('skill_id', { mode: 'number' }).notNull(),
    installationId: bigint('installation_id', { mode: 'number' }).notNull(),
    enabled: smallint().default(1).notNull(),
  },
  (table) => [
    index('repo_skills_repository_tenant_idx').using(
      'btree',
      table.repositoryId,
      table.installationId,
    ),
    index('repo_skills_skill_tenant_idx').using('btree', table.skillId, table.installationId),
    foreignKey({
      columns: [table.repositoryId, table.installationId],
      foreignColumns: [repositories.id, repositories.installationId],
      name: 'repo_skills_repository_tenant_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.skillId, table.installationId],
      foreignColumns: [skills.id, skills.installationId],
      name: 'repo_skills_skill_tenant_fk',
    }).onDelete('cascade'),
    primaryKey({ columns: [table.repositoryId, table.skillId], name: 'repo_skills_pkey' }),
    check('repo_skills_enabled_check', sql`enabled = ANY (ARRAY[0, 1])`),
  ],
);

export const repoConnections = appSchema.table(
  'repo_connections',
  {
    repositoryId: bigint('repository_id', { mode: 'number' }).notNull(),
    connectionId: bigint('connection_id', { mode: 'number' }).notNull(),
    installationId: bigint('installation_id', { mode: 'number' }).notNull(),
    reviews: smallint().default(1).notNull(),
    automations: smallint().default(1).notNull(),
  },
  (table) => [
    index('repo_connections_connection_tenant_idx').using(
      'btree',
      table.connectionId,
      table.installationId,
    ),
    index('repo_connections_repository_tenant_idx').using(
      'btree',
      table.repositoryId,
      table.installationId,
    ),
    foreignKey({
      columns: [table.repositoryId, table.installationId],
      foreignColumns: [repositories.id, repositories.installationId],
      name: 'repo_connections_repository_tenant_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.connectionId, table.installationId],
      foreignColumns: [connections.id, connections.installationId],
      name: 'repo_connections_connection_tenant_fk',
    }).onDelete('cascade'),
    primaryKey({
      columns: [table.repositoryId, table.connectionId],
      name: 'repo_connections_pkey',
    }),
    check('repo_connections_reviews_check', sql`reviews = ANY (ARRAY[0, 1])`),
    check('repo_connections_automations_check', sql`automations = ANY (ARRAY[0, 1])`),
  ],
);
