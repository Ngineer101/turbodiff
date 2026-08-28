import { sql, type SQL } from 'drizzle-orm';

/** Bind numeric entity ids as one PostgreSQL array parameter for `= ANY(...)`. */
export function bigintArray(ids: readonly number[]): SQL {
  return sql`${sql.param(ids)}::bigint[]`;
}

/** A timezone-safe PostgreSQL cutoff expression with a bound minute count. */
export function minutesAgo(minutes: number): SQL {
  return sql`CURRENT_TIMESTAMP - (${minutes}::double precision * INTERVAL '1 minute')`;
}
