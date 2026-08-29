import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';

const db = new PGlite();
const directory = path.resolve('db/migrations');
const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();

try {
  await migrate(drizzle(db), {
    migrationsFolder: directory,
    migrationsSchema: 'public',
    migrationsTable: 'schema_migrations',
  });
} catch (error) {
  throw new Error('Fresh Drizzle schema migration failed', { cause: error });
}

const schemas = await db.query(`
  SELECT table_schema, COUNT(*)::int AS count
  FROM information_schema.tables
  WHERE table_schema IN ('app', 'auth') AND table_type = 'BASE TABLE'
  GROUP BY table_schema
  ORDER BY table_schema
`);

const counts = new Map(schemas.rows.map((row) => [row.table_schema, row.count]));
if (counts.get('app') !== 31) throw new Error(`Expected 31 app tables, found ${counts.get('app')}`);
if (counts.get('auth') !== 10)
  throw new Error(`Expected 10 auth tables, found ${counts.get('auth')}`);

const ledger = await db.query('SELECT COUNT(*)::int AS count FROM public.schema_migrations');
if (ledger.rows[0]?.count !== files.length) {
  throw new Error(`Expected ${files.length} Drizzle ledger rows, found ${ledger.rows[0]?.count}`);
}

const missingForeignKeyIndexes = await db.query(`
  SELECT c.conrelid::regclass::text AS table_name, c.conname
  FROM pg_constraint c
  WHERE c.contype = 'f'
    AND c.connamespace IN ('app'::regnamespace, 'auth'::regnamespace)
    AND NOT EXISTS (
      SELECT 1 FROM pg_index i
      WHERE i.indrelid = c.conrelid
        AND (i.indkey::smallint[])[0:cardinality(c.conkey) - 1] = c.conkey
    )
`);
if (missingForeignKeyIndexes.rows.length > 0) {
  throw new Error(
    `Foreign keys without supporting indexes: ${JSON.stringify(missingForeignKeyIndexes.rows)}`,
  );
}

await db.exec(`
  SET search_path = app, auth, public;
  INSERT INTO installations (id, account_login, account_id, account_type)
  VALUES (1001, 'acme', 2001, 'Organization');
  INSERT INTO repositories (id, installation_id, owner, name)
  VALUES (3001, 1001, 'acme', 'rocket');
  INSERT INTO todos (installation_id, title) VALUES (1001, 'Ship the foundation');
  INSERT INTO plans (repository_id, title, requirements)
  VALUES (3001, 'Postgres', 'Use constraints and indexed foreign keys');
  INSERT INTO reviews
    (repository_id, installation_id, pr_number, trigger_event, status, agent_instance_id)
  VALUES (3001, 1001, 42, 'opened', 'running', 'review--acme--rocket--42');
  INSERT INTO auth."user"
    ("id", "name", "email", "createdAt", "updatedAt")
  VALUES ('auth-user', 'Auth User', 'auth@example.test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
  INSERT INTO auth."organization"
    ("id", "name", "slug", "logo", "metadata", "createdAt", "installationId")
  VALUES ('auth-org', 'Acme', 'acme', NULL, '{}', CURRENT_TIMESTAMP, 1001);
  INSERT INTO auth."session"
    ("id", "expiresAt", "token", "createdAt", "updatedAt", "activeOrganizationId", "userId")
  VALUES (
    'auth-session', CURRENT_TIMESTAMP + INTERVAL '1 day', 'auth-token',
    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'auth-org', 'auth-user'
  );
  INSERT INTO auth."oauthApplication"
    ("id", "clientId", "redirectUrls", "type", "createdAt", "updatedAt")
  VALUES (
    'oauth-app', 'oauth-client', 'https://client.example/callback', 'public',
    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  );
  INSERT INTO auth."oauthAccessToken"
    (
      "id", "accessToken", "refreshToken", "accessTokenExpiresAt", "refreshTokenExpiresAt",
      "clientId", "userId", "scopes", "createdAt", "updatedAt"
    )
  VALUES (
    'oauth-token', 'access-token', 'refresh-token', CURRENT_TIMESTAMP + INTERVAL '1 hour',
    CURRENT_TIMESTAMP + INTERVAL '1 day', 'oauth-client', 'auth-user', 'openid offline_access',
    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  );
  INSERT INTO auth."oauthConsent"
    ("id", "clientId", "userId", "scopes", "consentGiven", "createdAt", "updatedAt")
  VALUES (
    'oauth-consent', 'oauth-client', 'auth-user', 'openid offline_access', true,
    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  );
`);

await db.exec(`DELETE FROM auth."oauthApplication" WHERE "clientId" = 'oauth-client'`);
const oauthChildren = await db.query(`
  SELECT
    (SELECT COUNT(*)::int FROM auth."oauthAccessToken") AS tokens,
    (SELECT COUNT(*)::int FROM auth."oauthConsent") AS consents
`);
if (oauthChildren.rows[0]?.tokens !== 0 || oauthChildren.rows[0]?.consents !== 0) {
  throw new Error('OAuth client deletion did not cascade to tokens and consents');
}

await db.exec(`DELETE FROM auth."organization" WHERE "id" = 'auth-org'`);
const activeOrganization = await db.query(`
  SELECT "activeOrganizationId" FROM auth."session" WHERE "id" = 'auth-session'
`);
if (activeOrganization.rows[0]?.activeOrganizationId !== null) {
  throw new Error('Deleted active organization was not cleared from the session');
}

let duplicateRejected = false;
try {
  await db.exec(`
    INSERT INTO reviews
      (repository_id, installation_id, pr_number, trigger_event, status, agent_instance_id)
    VALUES (3001, 1001, 42, 'opened', 'running', 'review--acme--rocket--42')
  `);
} catch {
  duplicateRejected = true;
}
if (!duplicateRejected) throw new Error('The one-running-review invariant was not enforced');

await db.exec(`
  INSERT INTO installations (id, account_login, account_id, account_type)
  VALUES (1002, 'other', 2002, 'Organization');
  INSERT INTO agents (id, installation_id, slug, name, instructions)
  VALUES (5001, 1002, 'reviewer', 'Reviewer', 'Review carefully');
`);
let crossTenantLinkRejected = false;
try {
  await db.exec(`
    INSERT INTO repo_agents (repository_id, agent_id, installation_id)
    VALUES (3001, 5001, 1001)
  `);
} catch {
  crossTenantLinkRejected = true;
}
if (!crossTenantLinkRejected) throw new Error('Cross-tenant repository links were not rejected');

let providerMismatchRejected = false;
try {
  await db.exec(`
    INSERT INTO repositories (installation_id, owner, name, provider, artifacts_repo, default_branch)
    VALUES (1001, 'acme', 'mismatch', 'artifacts', 'acme--mismatch', 'main')
  `);
} catch {
  providerMismatchRejected = true;
}
if (!providerMismatchRejected)
  throw new Error('Installation/repository provider mismatch was accepted');

await db.exec(`
  INSERT INTO change_requests
    (repository_id, number, title, source_branch, target_branch, updated_at)
  VALUES
    (3001, app.next_change_request_number(3001), 'First', 'feature/one', 'main', '2020-01-01'),
    (3001, app.next_change_request_number(3001), 'Second', 'feature/two', 'main', '2020-01-01');
  UPDATE change_requests SET title = 'Touched' WHERE repository_id = 3001 AND number = 1;
`);
const changeRequests = await db.query(`
  SELECT number, updated_at > '2020-01-01'::timestamptz AS touched
  FROM change_requests WHERE repository_id = 3001 ORDER BY number
`);
if (changeRequests.rows[0]?.number !== 1 || changeRequests.rows[1]?.number !== 2) {
  throw new Error('Atomic change-request numbering did not allocate 1, 2');
}
if (!changeRequests.rows[0]?.touched) throw new Error('updated_at trigger did not run');

const version = await db.query('SELECT version FROM app.factory_version WHERE id = 1');
if (Number(version.rows[0]?.version) <= 1)
  throw new Error('Factory invalidation version did not advance');

const versionBeforeRollback = Number(version.rows[0]?.version);
await db.exec(`
  BEGIN;
  UPDATE plans SET title = 'Rolled back' WHERE repository_id = 3001;
  ROLLBACK;
`);
const versionAfterRollback = await db.query('SELECT version FROM app.factory_version WHERE id = 1');
if (Number(versionAfterRollback.rows[0]?.version) !== versionBeforeRollback) {
  throw new Error('Factory invalidation version escaped a rolled-back transaction');
}

await db.close();
console.log(`Fresh PostgreSQL schema passed (${files.length} migrations, 41 tables)`);
