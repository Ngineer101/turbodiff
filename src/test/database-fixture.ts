import { sql, type SQL } from 'drizzle-orm';
import type { QueryResultRow } from 'pg';
import { execute, queryOne, queryRows, withTransaction } from '../data/database.ts';
import type { JsonValue } from '../shared/json.ts';

// Small D1-shaped test adapter retained so existing fixtures remain readable.
// It deliberately executes through the production Drizzle connection helpers,
// keeping connection configuration and PostgreSQL result parsing in one place.
interface QueryMeta {
  changes: number;
}

interface QueryRunResult {
  success: true;
  meta: QueryMeta;
}

interface QueryRowsResult<Row> {
  success: true;
  results: Row[];
  meta: QueryMeta;
}

type BindValue = JsonValue | undefined | Uint8Array | Date | readonly number[];

function boundSql(text: string, values: BindValue[]): SQL {
  const chunks: SQL[] = [];
  let cursor = 0;
  for (const match of text.matchAll(/\?(\d+)/g)) {
    const offset = match.index;
    chunks.push(sql.raw(text.slice(cursor, offset)));
    const value = values[Number(match[1]) - 1];
    chunks.push(sql`${value === undefined ? null : value}`);
    cursor = offset + match[0].length;
  }
  chunks.push(sql.raw(text.slice(cursor)));
  return sql.join(chunks, sql.empty());
}

class PreparedQuery {
  readonly text: string;
  readonly values: BindValue[];

  constructor(text: string, values: BindValue[] = []) {
    this.text = text;
    this.values = values;
  }

  bind(...values: BindValue[]): PreparedQuery {
    return new PreparedQuery(this.text, values);
  }

  statement(): SQL {
    return boundSql(this.text, this.values);
  }

  async first<Row extends QueryResultRow>(): Promise<Row | null> {
    return queryOne<Row>(this.statement());
  }

  async all<Row extends QueryResultRow>(): Promise<QueryRowsResult<Row>> {
    const results = await queryRows<Row>(this.statement());
    return { success: true, results, meta: { changes: results.length } };
  }

  async run(): Promise<QueryRunResult> {
    const changes = await execute(this.statement());
    return { success: true, meta: { changes } };
  }
}

class TestDatabaseFixture {
  prepare(text: string): PreparedQuery {
    return new PreparedQuery(text);
  }

  async batch<Row extends QueryResultRow = QueryResultRow>(
    queries: PreparedQuery[],
  ): Promise<QueryRowsResult<Row>[]> {
    if (queries.length === 0) return [];
    return withTransaction(async (transaction) => {
      const results: QueryRowsResult<Row>[] = [];
      for (const query of queries) {
        const result = await transaction.execute<Row>(query.statement());
        // SAFETY: the generic row type is supplied alongside each fixture's static SQL projection.
        results.push({
          success: true,
          results: result.rows as Row[],
          meta: { changes: result.rowCount ?? 0 },
        });
      }
      return results;
    });
  }
}

const instance = new TestDatabaseFixture();

export function testDatabase(): TestDatabaseFixture {
  return instance;
}
