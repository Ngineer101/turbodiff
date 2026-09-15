import process from 'node:process';
import { Client } from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');

const client = new Client({ connectionString, application_name: 'turbodiff-schema-verifier' });
await client.connect();
try {
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
          AND (i.indkey::smallint[])[0] = c.conkey[1]
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
