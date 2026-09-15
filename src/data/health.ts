import { sql } from 'drizzle-orm';
import { execute } from './postgres.ts';

export async function databaseIsHealthy(): Promise<void> {
  await execute(sql`SELECT 1`);
}
