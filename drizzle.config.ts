import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/data/schema.ts',
  out: './db/migrations',
  schemaFilter: ['app', 'auth'],
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  migrations: {
    schema: 'public',
    table: 'schema_migrations',
  },
  strict: true,
  verbose: true,
});
