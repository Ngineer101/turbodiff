import process from 'node:process';
import { Client } from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');

const hostname = new URL(connectionString).hostname;
if (hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '::1') {
  throw new Error(`Refusing to reset a non-local PostgreSQL host: ${hostname}`);
}

const client = new Client({ connectionString, application_name: 'turbodiff-test-reset' });
await client.connect();
try {
  const tables = await client.query(`
    SELECT format('%I.%I', table_schema, table_name) AS relation
    FROM information_schema.tables
    WHERE table_schema IN ('app', 'auth') AND table_type = 'BASE TABLE'
    ORDER BY table_schema, table_name
  `);
  if (tables.rowCount) {
    await client.query(
      `TRUNCATE TABLE ${tables.rows.map((row) => row.relation).join(', ')} RESTART IDENTITY CASCADE`,
    );
  }
  await client.query('ALTER SEQUENCE app.native_entity_id_seq RESTART WITH 4000000000000000');
  await client.query('UPDATE app.factory_version SET version = 1 WHERE id = 1');
  console.log('Local PostgreSQL test data reset');
} finally {
  await client.end();
}
