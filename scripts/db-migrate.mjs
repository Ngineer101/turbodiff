import process from 'node:process';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { Client } from 'pg';

const MIGRATION_CONFIG = {
  migrationsFolder: 'db/migrations',
  migrationsSchema: 'public',
  migrationsTable: 'schema_migrations',
};
const LOCK_ID = 7_845_223_901;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');

const command = process.argv[2] ?? 'up';
if (command !== 'up' && command !== 'status') {
  throw new Error(`Unknown command: ${command}. Expected "up" or "status".`);
}

const client = new Client({
  connectionString,
  application_name: 'turbodiff-migrations',
});
await client.connect();

async function appliedMigrations() {
  const exists = await client.query(
    `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists`,
  );
  if (!exists.rows[0]?.exists) return [];
  const applied = await client.query(
    'SELECT hash, created_at FROM public.schema_migrations ORDER BY created_at',
  );
  return applied.rows;
}

function validateLedger(expected, applied) {
  const expectedByTimestamp = new Map(
    expected.map((migration) => [migration.folderMillis, migration.hash]),
  );
  const appliedTimestamps = new Set();
  for (const row of applied) {
    const timestamp = Number(row.created_at);
    if (appliedTimestamps.has(timestamp)) {
      throw new Error(`Migration ${timestamp} appears more than once in the ledger`);
    }
    appliedTimestamps.add(timestamp);
    const hash = expectedByTimestamp.get(timestamp);
    if (!hash) throw new Error(`Applied migration ${timestamp} is missing from the repository`);
    if (hash !== row.hash) throw new Error(`Applied migration ${timestamp} was modified`);
  }

  let foundGap = false;
  for (const migration of expected) {
    if (!appliedTimestamps.has(migration.folderMillis)) foundGap = true;
    else if (foundGap) {
      throw new Error(`Migration ${migration.folderMillis} was applied after a ledger gap`);
    }
  }
}

try {
  await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
  const database = drizzle(client);
  const expected = readMigrationFiles(MIGRATION_CONFIG);
  const applied = await appliedMigrations();
  validateLedger(expected, applied);

  if (command === 'up') {
    await migrate(database, MIGRATION_CONFIG);
    console.log('Drizzle migrations applied');
  } else {
    const appliedTimestamps = new Set(applied.map((row) => Number(row.created_at)));
    for (const migration of expected) {
      const state = appliedTimestamps.has(migration.folderMillis) ? 'applied' : 'pending';
      console.log(`${state.padEnd(8)} ${migration.folderMillis}`);
    }
  }
} finally {
  await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined);
  await client.end();
}
