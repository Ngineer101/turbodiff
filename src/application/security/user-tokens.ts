import { sql } from 'drizzle-orm';
import { queryOne } from '../../data/database.ts';
import { withAuth } from '../../integrations/auth/better-auth.ts';
import { encryptionConfigured, openToken, sealToken } from '../../integrations/security/crypto.ts';
import {
  deleteUserRefreshToken,
  getUserRefreshToken,
  saveUserRefreshToken,
} from '../../data/db.ts';
import { refreshUserToken } from '../../integrations/github/app.ts';

export async function mintUserToken(userId: number): Promise<string | null> {
  // Preferred: the better-auth account, keyed by the user's GitHub id.
  const baUser = await queryOne<{ id: string }>(sql`
    SELECT id FROM auth."user" WHERE "githubId" = ${userId}
  `);
  if (baUser) {
    try {
      const { accessToken } = await withAuth((instance) =>
        instance.api.getAccessToken({
          body: { providerId: 'github', userId: baUser.id },
        }),
      );
      if (accessToken) return accessToken;
    } catch {
      // fall through to the legacy store
    }
  }
  if (!encryptionConfigured()) return null;
  const legacy = await getUserRefreshToken(userId);
  if (!legacy) return null;
  let refreshToken: string;
  try {
    refreshToken = await openToken(legacy.refresh_ciphertext);
  } catch {
    await deleteUserRefreshToken(userId);
    return null;
  }
  const rotated = await refreshUserToken(refreshToken);
  if (!rotated) {
    await deleteUserRefreshToken(userId);
    return null;
  }
  if (rotated.refreshToken) {
    await saveUserRefreshToken(userId, legacy.login, await sealToken(rotated.refreshToken));
  }
  return rotated.token;
}
