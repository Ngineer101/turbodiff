import { database } from './postgres.ts';

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
  await database()
    .prepare(
      `INSERT INTO user_tokens (user_id, login, refresh_ciphertext, updated_at)
		 VALUES (?1, ?2, ?3, CURRENT_TIMESTAMP)
		 ON CONFLICT(user_id) DO UPDATE SET
		   login = excluded.login,
		   refresh_ciphertext = excluded.refresh_ciphertext,
		   updated_at = excluded.updated_at`,
    )
    .bind(userId, login, refreshCiphertext)
    .run();
}

export async function getUserRefreshToken(userId: number): Promise<UserTokenRow | null> {
  return database()
    .prepare('SELECT * FROM user_tokens WHERE user_id = ?1')
    .bind(userId)
    .first<UserTokenRow>();
}

export async function deleteUserRefreshToken(userId: number): Promise<void> {
  await database().prepare('DELETE FROM user_tokens WHERE user_id = ?1').bind(userId).run();
}
