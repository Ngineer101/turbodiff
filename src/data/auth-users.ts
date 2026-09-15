import { sql } from 'drizzle-orm';
import { queryOne } from './postgres.ts';

export interface AuthUserRow {
  id: string;
  name: string;
  email: string;
  login: string | null;
  githubId: number | null;
}

export async function getAuthUser(id: string): Promise<AuthUserRow | null> {
  return queryOne<AuthUserRow>(sql`
    SELECT id, name, email, login, "githubId" AS "githubId"
    FROM auth."user"
    WHERE id = ${id}
  `);
}
