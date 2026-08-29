import { env } from 'cloudflare:workers';
import { AsyncLocalStorage } from 'node:async_hooks';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Client, types, type QueryResultRow } from 'pg';
import type { SQL } from 'drizzle-orm';
import * as schema from './schema.ts';

// Keep raw SQL results aligned with the application's transport types. Drizzle's
// schema-aware query builder still applies each column's own mapper.
types.setTypeParser(20, Number);
types.setTypeParser(1700, Number);
types.setTypeParser(1083, (value) => value.slice(0, 5));

export type Database = NodePgDatabase<typeof schema>;
type DatabaseTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type DatabaseExecutor = Database | DatabaseTransaction;

interface DatabaseScope {
  database?: Promise<DatabaseExecutor>;
}

const databaseScope = new AsyncLocalStorage<DatabaseScope>();

export function postgresClient(onError?: () => void): Client {
  const connection = new Client({
    connectionString: env.HYPERDRIVE.connectionString,
    options: '-c search_path=app,auth,public',
    connectionTimeoutMillis: 10_000,
    query_timeout: 55_000,
    statement_timeout: 55_000,
    application_name: 'turbodiff-worker',
  });
  // pg emits idle-socket failures as Client 'error' events. Without a
  // listener Node treats one as an uncaught exception and kills the Worker
  // invocation; clear the scoped client as well so the next data call can
  // reconnect through Hyperdrive.
  connection.on('error', (error) => {
    console.error(
      JSON.stringify({
        message: 'turbodiff: PostgreSQL client error',
        error: error.message,
        code: 'code' in error ? error.code : undefined,
      }),
    );
    onError?.();
  });
  return connection;
}

async function connectDatabase(onError?: () => void): Promise<{
  connection: Client;
  database: Database;
}> {
  const connection = postgresClient(onError);
  await connection.connect();
  return { connection, database: drizzle(connection, { schema }) };
}

function scopedDatabase(scope: DatabaseScope): Promise<DatabaseExecutor> {
  if (scope.database) return scope.database;

  let pending: Promise<DatabaseExecutor>;
  const clearPending = () => {
    if (scope.database === pending) scope.database = undefined;
  };
  pending = connectDatabase(clearPending).then(({ database }) => database);
  scope.database = pending;
  // Cache only a successful connection. A transient connect failure must not
  // poison every later query in the same request or queue batch. This branch
  // clears the cache while the original promise still rejects to its caller.
  void pending.catch(clearPending);
  return pending;
}

/**
 * Scope all data calls in one Worker invocation to one lazy Hyperdrive client.
 * Hyperdrive cleans up the edge connection when the invocation ends, so the
 * response does not wait for client.end(). Calls that happen outside an
 * invocation scope retain explicit cleanup for tests and isolated jobs.
 */
export function withDatabaseScope<Result>(operation: () => Promise<Result>): Promise<Result> {
  if (databaseScope.getStore()) return operation();
  return databaseScope.run({}, operation);
}

/** Use the invocation client when scoped; otherwise own a short-lived client. */
export async function withDatabase<Result>(
  operation: (database: DatabaseExecutor) => Promise<Result>,
): Promise<Result> {
  const scope = databaseScope.getStore();
  if (scope) {
    return operation(await scopedDatabase(scope));
  }

  const { connection, database } = await connectDatabase();
  try {
    return await operation(database);
  } finally {
    await connection.end();
  }
}

export function withTransaction<Result>(
  operation: (transaction: DatabaseTransaction) => Promise<Result>,
): Promise<Result> {
  return withDatabase((database) =>
    database.transaction((transaction) =>
      databaseScope.run({ database: Promise.resolve(transaction) }, () => operation(transaction)),
    ),
  );
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
