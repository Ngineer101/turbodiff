import { env } from 'cloudflare:workers';
import { auth } from './better-auth.ts';
import { encryptionConfigured, openToken, sealToken } from './crypto.ts';
import { deleteUserRefreshToken, getUserRefreshToken, saveUserRefreshToken } from './db.ts';
import { refreshUserToken } from './github-app.ts';

// Per-user GitHub credentials for async attribution: factory runs mint a
// fresh user access token whenever an action should be performed AS the
// instructing user (e.g. opening the generated PR). The better-auth github
// account row is the store (encrypted, refreshed and rotated by better-auth
// alone — a second refresher would invalidate it, GitHub rotates the refresh
// token on every use). The pre-better-auth user_tokens rows remain as a
// read-only fallback for users who haven't signed in since the migration.

// A fresh user access token, or null when unavailable (never signed in,
// revoked, or expired credentials — stale legacy rows are dropped so we
// stop trying them).
export async function mintUserToken(userId: number): Promise<string | null> {
  // Preferred: the better-auth account, keyed by the user's GitHub id.
  const baUser = await env.DB.prepare('SELECT "id" FROM "user" WHERE "githubId" = ?1')
    .bind(userId)
    .first<{ id: string }>();
  if (baUser) {
    try {
      const { accessToken } = await auth().api.getAccessToken({
        body: { providerId: 'github', userId: baUser.id },
      });
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
