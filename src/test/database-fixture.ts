import { env } from 'cloudflare:workers';
import { Client, types, type QueryResultRow } from 'pg';
import { isJsonObject, type JsonValue } from '../shared/json.ts';

// Test-only raw SQL fixture for arranging rows and inspecting side effects.
// Production data access lives in src/data/database.ts and uses Drizzle.
types.setTypeParser(20, Number);
types.setTypeParser(1700, Number);
types.setTypeParser(1083, (value) => value.slice(0, 5));

export interface QueryMeta {
  changes: number;
}

export interface QueryRunResult {
  success: true;
  meta: QueryMeta;
}

export interface QueryRowsResult<Row> {
  success: true;
  results: Row[];
  meta: QueryMeta;
}

type BindValue = JsonValue | undefined | Uint8Array | Date | readonly number[];
type DriverValue = JsonValue | Date | Uint8Array;

function postgresSql(sql: string): string {
  return sql.replace(/\?(\d+)/g, (_match, index: string) => `$${index}`);
}

function normalizeValue<Value extends DriverValue>(value: Value): JsonValue | Uint8Array {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return JSON.stringify(value);
  if (isJsonObject(value)) return JSON.stringify(value);
  return value;
}

function normalizeRow<Row>(row: QueryResultRow): Row {
  // SAFETY: callers supply the row interface paired with their static SELECT;
  // this adapter preserves column names and only normalizes transport values.
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, normalizeValue(value)]),
  ) as Row;
}

function client(): Client {
  return new Client({
    connectionString: env.HYPERDRIVE.connectionString,
    options: '-c search_path=app,auth,public',
    connectionTimeoutMillis: 10_000,
    query_timeout: 55_000,
    statement_timeout: 55_000,
    application_name: 'turbodiff-worker',
  });
}

async function withClient<Result>(operation: (sql: Client) => Promise<Result>): Promise<Result> {
  const sql = client();
  await sql.connect();
  try {
    return await operation(sql);
  } finally {
    await sql.end();
  }
}

export class PreparedQuery {
  readonly text: string;
  readonly values: BindValue[];

  constructor(text: string, values: BindValue[] = []) {
    this.text = postgresSql(text);
    this.values = values;
  }

  bind(...values: BindValue[]): PreparedQuery {
    return new PreparedQuery(this.text, values);
  }

  async first<Row>(): Promise<Row | null> {
    return withClient(async (sql) => {
      const result = await sql.query(this.text, this.values);
      const row = result.rows[0];
      return row ? normalizeRow<Row>(row) : null;
    });
  }

  async all<Row>(): Promise<QueryRowsResult<Row>> {
    return withClient(async (sql) => {
      const result = await sql.query(this.text, this.values);
      return {
        success: true,
        results: result.rows.map((row) => normalizeRow<Row>(row)),
        meta: { changes: result.rowCount ?? 0 },
      };
    });
  }

  async run(): Promise<QueryRunResult> {
    return withClient(async (sql) => {
      const result = await sql.query(this.text, this.values);
      return { success: true, meta: { changes: result.rowCount ?? 0 } };
    });
  }
}

export class TestDatabaseFixture {
  prepare(text: string): PreparedQuery {
    return new PreparedQuery(text);
  }

  async batch<Row extends QueryResultRow = QueryResultRow>(
    queries: PreparedQuery[],
  ): Promise<QueryRowsResult<Row>[]> {
    if (queries.length === 0) return [];
    return withClient(async (sql) => {
      await sql.query('BEGIN');
      try {
        const results: QueryRowsResult<Row>[] = [];
        for (const query of queries) {
          const result = await sql.query(query.text, query.values);
          results.push({
            success: true,
            results: result.rows.map((row) => normalizeRow<Row>(row)),
            meta: { changes: result.rowCount ?? 0 },
          });
        }
        await sql.query('COMMIT');
        return results;
      } catch (error) {
        await sql.query('ROLLBACK');
        throw error;
      }
    });
  }
}

const instance = new TestDatabaseFixture();

export function testDatabase(): TestDatabaseFixture {
  return instance;
}
