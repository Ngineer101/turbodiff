/* oxlint-disable typescript/triple-slash-reference -- generated Worker bindings */
/// <reference path="../../worker-configuration.d.ts" />
/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { describe, expect, it } from 'vite-plus/test';
import type { D1Migration } from '@cloudflare/vitest-pool-workers';

type TestEnv = Cloudflare.Env & {
  TEST_MIGRATIONS: D1Migration[];
  DB_MIGRATIONS_FRESH: D1Database;
  DB_MIGRATIONS_CONNECTIONS: D1Database;
  DB_MIGRATIONS_MULTI_REPO: D1Database;
  DB_MIGRATIONS_IDEMPOTENCY: D1Database;
};
const testEnv = env as TestEnv;

function migrationIndex(name: string): number {
  const index = testEnv.TEST_MIGRATIONS.findIndex((migration) => migration.name === name);
  if (index === -1) throw new Error(`migration fixture not found: ${name}`);
  return index;
}

async function applyBefore(db: D1Database, name: string): Promise<number> {
  const index = migrationIndex(name);
  await applyD1Migrations(db, testEnv.TEST_MIGRATIONS.slice(0, index));
  return index;
}

describe('D1 migrations', () => {
  it('builds the complete production schema from an empty database', async () => {
    const db = testEnv.DB_MIGRATIONS_FRESH;
    await applyD1Migrations(db, testEnv.TEST_MIGRATIONS);

    const schema = await db
      .prepare(
        `SELECT name FROM sqlite_master
		 WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
		 ORDER BY name`,
      )
      .all<{ name: string }>();
    const names = schema.results.map((row) => row.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'account',
        'agent_runs',
        'automations',
        'automation_runs',
        'connections',
        'features',
        'invitation',
        'member',
        'organization',
        'plans',
        'repositories',
        'reviews',
        'session',
        'todos',
        'user',
        'verifications',
      ]),
    );
    const applied = await db.prepare('SELECT COUNT(*) AS count FROM d1_migrations').first<{
      count: number;
    }>();
    expect(applied?.count).toBe(testEnv.TEST_MIGRATIONS.length);
  });

  it('preserves legacy agent connections while moving them to the registry', async () => {
    const db = testEnv.DB_MIGRATIONS_CONNECTIONS;
    const start = await applyBefore(db, '0022_board_and_integrations.sql');
    await db.batch([
      db.prepare(
        `INSERT INTO installations (id, account_login, account_id, account_type)
		 VALUES (1001, 'acme', 2001, 'Organization')`,
      ),
      db.prepare(
        `INSERT INTO agents (id, installation_id, slug, name, instructions)
		 VALUES (11, 1001, 'review', 'Review', 'Review the change')`,
      ),
      db.prepare(
        `INSERT INTO agent_connections
		 (id, agent_id, name, url, tool_allowlist, auth_ciphertext, optional)
		 VALUES (21, 11, 'catalog', 'https://mcp.example.test', '["search"]', 'sealed', 0)`,
      ),
    ]);

    await applyD1Migrations(db, testEnv.TEST_MIGRATIONS.slice(start));

    const connection = await db
      .prepare(
        `SELECT c.*, l.agent_id FROM connections c
		 JOIN agent_connection_links l ON l.connection_id = c.id`,
      )
      .first<{ name: string; auth_ciphertext: string; optional: number; agent_id: number }>();
    expect(connection).toMatchObject({
      name: 'catalog',
      auth_ciphertext: 'sealed',
      optional: 0,
      agent_id: 11,
    });
  });

  it('backfills multi-repo ownership for existing plans and features', async () => {
    const db = testEnv.DB_MIGRATIONS_MULTI_REPO;
    const start = await applyBefore(db, '0024_multi_repo_tasks.sql');
    await db.batch([
      db.prepare(
        `INSERT INTO installations (id, account_login, account_id, account_type)
		 VALUES (1001, 'acme', 2001, 'Organization')`,
      ),
      db.prepare(
        `INSERT INTO repositories (id, installation_id, owner, name)
		 VALUES (101, 1001, 'acme', 'api')`,
      ),
      db.prepare(
        `INSERT INTO features (id, repository_id, title, spec)
		 VALUES (301, 101, 'Existing feature', 'Existing spec')`,
      ),
      db.prepare(
        `INSERT INTO plans (id, repository_id, title, requirements, feature_id, status)
		 VALUES (201, 101, 'Existing plan', 'Existing requirements', 301, 'approved')`,
      ),
    ]);

    await applyD1Migrations(db, testEnv.TEST_MIGRATIONS.slice(start));

    const repoLink = await db
      .prepare('SELECT repository_id, position FROM plan_repositories WHERE plan_id = 201')
      .first<{ repository_id: number; position: number }>();
    const feature = await db.prepare('SELECT plan_id FROM features WHERE id = 301').first<{
      plan_id: number;
    }>();
    expect(repoLink).toEqual({ repository_id: 101, position: 0 });
    expect(feature?.plan_id).toBe(201);
  });

  it('backfills a todo origin and enforces one plan per todo', async () => {
    const db = testEnv.DB_MIGRATIONS_IDEMPOTENCY;
    const start = await applyBefore(db, '0029_idempotency.sql');
    await db.batch([
      db.prepare(
        `INSERT INTO installations (id, account_login, account_id, account_type)
		 VALUES (1001, 'acme', 2001, 'Organization')`,
      ),
      db.prepare(
        `INSERT INTO repositories (id, installation_id, owner, name)
		 VALUES (101, 1001, 'acme', 'api')`,
      ),
      db.prepare(
        `INSERT INTO plans (id, repository_id, title, requirements)
		 VALUES (201, 101, 'Existing plan', 'Existing requirements')`,
      ),
      db.prepare(
        `INSERT INTO todos (id, installation_id, title, plan_id)
		 VALUES (401, 1001, 'Existing todo', 201)`,
      ),
    ]);

    await applyD1Migrations(db, testEnv.TEST_MIGRATIONS.slice(start));

    const plan = await db.prepare('SELECT todo_id FROM plans WHERE id = 201').first<{
      todo_id: number;
    }>();
    expect(plan?.todo_id).toBe(401);
    await expect(
      db
        .prepare(
          `INSERT INTO plans (repository_id, title, requirements, todo_id)
		 VALUES (101, 'Duplicate', 'Must fail', 401)`,
        )
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed/);
  });
});
