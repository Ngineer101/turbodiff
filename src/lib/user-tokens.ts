import { encryptionConfigured, openToken, sealToken } from './crypto.ts';
import { deleteUserRefreshToken, getUserRefreshToken, saveUserRefreshToken } from './db.ts';
import { refreshUserToken, type OAuthTokens } from './github-app.ts';

// Durable per-user GitHub credentials for async attribution: sign-in stores
// the (encrypted) OAuth refresh token; factory runs mint a fresh 8h user
// access token from it whenever an action should be performed AS the
// instructing user (e.g. opening the generated PR). GitHub rotates the
// refresh token on every use, so each mint re-seals the replacement.

export async function storeUserCredential(
  userId: number,
  login: string,
  tokens: OAuthTokens,
): Promise<void> {
  if (!tokens.refreshToken || !encryptionConfigured()) return;
  await saveUserRefreshToken(userId, login, await sealToken(tokens.refreshToken));
}

// A fresh user access token, or null when unavailable (never signed in since
// the feature shipped, encryption unconfigured, or the refresh token was
// revoked/expired — in which case the stale row is dropped so we stop trying).
export async function mintUserToken(userId: number): Promise<string | null> {
  if (!encryptionConfigured()) return null;
  const row = await getUserRefreshToken(userId);
  if (!row) return null;
  let refreshToken: string;
  try {
    refreshToken = await openToken(row.refresh_ciphertext);
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
    await saveUserRefreshToken(userId, row.login, await sealToken(rotated.refreshToken));
  }
  return rotated.token;
}
