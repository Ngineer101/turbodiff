import { sql } from 'drizzle-orm';
import { execute, queryOne } from './database.ts';

// --- durable user OAuth credentials (PR-opener attribution) ---

export interface UserTokenRow {
  user_id: number;
  login: string;
  refresh_ciphertext: string;
  updated_at: string;
}

export async function saveUserRefreshToken(
  userId: number,
  login: string,
  refreshCiphertext: string,
): Promise<void> {
  await execute(sql`
    INSERT INTO app.user_tokens (user_id, login, refresh_ciphertext, updated_at)
    VALUES (${userId}, ${login}, ${refreshCiphertext}, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      login = excluded.login,
      refresh_ciphertext = excluded.refresh_ciphertext,
      updated_at = excluded.updated_at
  `);
}

export async function getUserRefreshToken(userId: number): Promise<UserTokenRow | null> {
  return queryOne<UserTokenRow>(sql`
    SELECT * FROM app.user_tokens WHERE user_id = ${userId}
  `);
}

export async function deleteUserRefreshToken(userId: number): Promise<void> {
  await execute(sql`DELETE FROM app.user_tokens WHERE user_id = ${userId}`);
}
