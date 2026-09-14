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
  // The model catalog is deployment configuration, so restore it after the reset.
  await client.query(`
    INSERT INTO app.models
      (provider, model_id, label, capabilities, enabled, is_default, is_fast_default)
    VALUES
      ('openai', 'gpt-5.6-sol', 'GPT-5.6 Sol', ARRAY['text', 'tools', 'reasoning'], true, true, false),
      ('anthropic', 'claude-opus-4.8', 'Claude Opus 4.8', ARRAY['text', 'tools', 'reasoning'], true, false, true)
  `);
  console.log('Local PostgreSQL test data reset');
} finally {
  await client.end();
}
