import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { Client } from 'pg';

const MIGRATIONS_DIR = path.resolve('db/migrations');
const LOCK_ID = 7_845_223_901;

function databaseUrl() {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error('DATABASE_URL is required');
  return value;
}

async function migrationFiles() {
  return (await readdir(MIGRATIONS_DIR))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
}

function checksum(sql) {
  return createHash('sha256').update(sql).digest('hex');
}

async function ensureLedger(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      version text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function appliedMigrations(client) {
  const result = await client.query(
    'SELECT version, checksum, applied_at FROM public.schema_migrations ORDER BY version',
  );
  return new Map(result.rows.map((row) => [row.version, row]));
}

async function status(client, files) {
  const applied = await appliedMigrations(client);
  let invalid = false;
  for (const file of files) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    const row = applied.get(file);
    const state = !row ? 'pending' : row.checksum === checksum(sql) ? 'applied' : 'CHANGED';
    if (state === 'CHANGED') invalid = true;
    console.log(`${state.padEnd(8)} ${file}`);
  }
  const unknown = [...applied.keys()].filter((file) => !files.includes(file));
  for (const file of unknown) console.log(`missing  ${file}`);
  if (unknown.length > 0 || invalid) process.exitCode = 1;
}

async function migrate(client, files) {
  const applied = await appliedMigrations(client);
  const unknown = [...applied.keys()].filter((file) => !files.includes(file));
  if (unknown.length > 0) {
    throw new Error(`Applied migrations are missing from the repository: ${unknown.join(', ')}`);
  }
  for (const file of files) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    const digest = checksum(sql);
    const existing = applied.get(file);
    if (existing) {
      if (existing.checksum !== digest) {
        throw new Error(`Applied migration was modified: ${file}`);
      }
      continue;
    }

    console.log(`applying ${file}`);
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query(
        'INSERT INTO public.schema_migrations (version, checksum) VALUES ($1, $2)',
        [file, digest],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
}

const command = process.argv[2] ?? 'up';
if (command !== 'up' && command !== 'status') {
  throw new Error(`Unknown command: ${command}. Expected "up" or "status".`);
}

const client = new Client({
  connectionString: databaseUrl(),
  application_name: 'turbodiff-migrations',
});

await client.connect();
try {
  await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
  await ensureLedger(client);
  const files = await migrationFiles();
  if (files.length === 0) throw new Error(`No migrations found in ${MIGRATIONS_DIR}`);
  if (command === 'status') await status(client, files);
  else await migrate(client, files);
} finally {
  await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined);
  await client.end();
}
