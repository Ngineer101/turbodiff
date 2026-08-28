import { env } from 'cloudflare:workers';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Client, Pool, types, type QueryResultRow } from 'pg';
import type { SQL } from 'drizzle-orm';
import * as schema from './schema.ts';

// Keep raw SQL results aligned with the application's transport types. Drizzle's
// schema-aware query builder still applies each column's own mapper.
types.setTypeParser(20, Number);
types.setTypeParser(1700, Number);
types.setTypeParser(1083, (value) => value.slice(0, 5));
types.setTypeParser(1114, (value) => new Date(`${value}Z`).toISOString());
types.setTypeParser(1184, (value) => new Date(value).toISOString());
types.setTypeParser(114, (value) => value);
types.setTypeParser(3802, (value) => value);

export type Database = NodePgDatabase<typeof schema>;

function client(applicationName: string): Client {
  return new Client({
    connectionString: env.HYPERDRIVE.connectionString,
    options: '-c search_path=app,auth,public',
    connectionTimeoutMillis: 10_000,
    query_timeout: 55_000,
    statement_timeout: 55_000,
    application_name: applicationName,
  });
}

/**
 * Run one logical data-layer operation on a fresh Hyperdrive connection.
 * Cloudflare recommends a new node-postgres Client for each Worker request;
 * repository operations are the narrower lifetime boundary in this app.
 */
export async function withDatabase<Result>(
  operation: (database: Database) => Promise<Result>,
): Promise<Result> {
  const connection = client('turbodiff-worker');
  await connection.connect();
  try {
    return await operation(drizzle(connection, { schema }));
  } finally {
    await connection.end();
  }
}

export async function queryRows<Row extends QueryResultRow>(query: SQL): Promise<Row[]> {
  return withDatabase(async (database) => {
    const result = await database.execute<Row>(query);
    // SAFETY: each repository supplies the row contract paired with its static SQL projection.
    return result.rows as Row[];
  });
}

export async function queryOne<Row extends QueryResultRow>(query: SQL): Promise<Row | null> {
  const rows = await queryRows<Row>(query);
  return rows[0] ?? null;
}

export async function execute(query: SQL): Promise<number> {
  return withDatabase(async (database) => (await database.execute(query)).rowCount ?? 0);
}

// Better Auth owns several queries per request, so its Drizzle adapter uses a
// small Pool instead of opening and closing a Client between adapter calls.
// Hyperdrive remains the actual connection pool in front of PlanetScale.
let authPool: Pool | undefined;
let authDb: Database | undefined;

export function authDatabase(): Database {
  authPool ??= new Pool({
    connectionString: env.HYPERDRIVE.connectionString,
    options: '-c search_path=auth,app,public',
    max: 5,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    application_name: 'turbodiff-auth',
  });
  authDb ??= drizzle(authPool, { schema });
  return authDb;
}
