import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const directory = path.resolve('db/migrations');
const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();

for (const file of files) {
  const sql = await readFile(path.join(directory, file), 'utf8');
  try {
    await db.exec(sql);
  } catch (error) {
    throw new Error(`Fresh schema failed at ${file}`, { cause: error });
  }
}

const schemas = await db.query(`
  SELECT table_schema, COUNT(*)::int AS count
  FROM information_schema.tables
  WHERE table_schema IN ('app', 'auth') AND table_type = 'BASE TABLE'
  GROUP BY table_schema
  ORDER BY table_schema
`);

const counts = new Map(schemas.rows.map((row) => [row.table_schema, row.count]));
if (counts.get('app') !== 30) throw new Error(`Expected 30 app tables, found ${counts.get('app')}`);
if (counts.get('auth') !== 10)
  throw new Error(`Expected 10 auth tables, found ${counts.get('auth')}`);

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

const version = await db.query('SELECT last_value::bigint AS version FROM app.factory_version_seq');
if (Number(version.rows[0]?.version) <= 1)
  throw new Error('Factory invalidation sequence did not advance');

await db.close();
console.log(`Fresh PostgreSQL schema passed (${files.length} migrations, 40 tables)`);
