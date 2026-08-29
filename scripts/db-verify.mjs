import process from 'node:process';
import { Client } from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');

const client = new Client({ connectionString, application_name: 'turbodiff-schema-verifier' });
await client.connect();
try {
  const expected = new Map([
    ['app', 31],
    ['auth', 10],
  ]);
  const relations = await client.query(`
    SELECT table_schema, COUNT(*)::int AS count
    FROM information_schema.tables
    WHERE table_schema IN ('app', 'auth') AND table_type = 'BASE TABLE'
    GROUP BY table_schema
  `);
  for (const row of relations.rows) {
    const minimum = expected.get(row.table_schema);
    if (minimum !== undefined && row.count < minimum) {
      throw new Error(`${row.table_schema} has ${row.count} tables; expected at least ${minimum}`);
    }
    expected.delete(row.table_schema);
  }
  if (expected.size > 0) throw new Error(`Missing schemas: ${[...expected.keys()].join(', ')}`);

  const invalid = await client.query(`
    SELECT conrelid::regclass::text AS table_name, conname
    FROM pg_constraint
    WHERE contype = 'f'
      AND connamespace IN ('app'::regnamespace, 'auth'::regnamespace)
      AND NOT convalidated
  `);
  if (invalid.rowCount)
    throw new Error(`Unvalidated foreign keys: ${JSON.stringify(invalid.rows)}`);

  const missingForeignKeyIndexes = await client.query(`
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
  if (missingForeignKeyIndexes.rowCount) {
    throw new Error(
      `Foreign keys without supporting indexes: ${JSON.stringify(missingForeignKeyIndexes.rows)}`,
    );
  }

  console.log('PostgreSQL schema verification passed');
} finally {
  await client.end();
}
