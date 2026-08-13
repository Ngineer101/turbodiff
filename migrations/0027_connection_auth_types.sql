-- Generalizes connection auth beyond a single bearer token: auth_type picks
-- the method, auth_config_ciphertext is a generic sealed JSON blob shaped by
-- that type (api_key: {headerName, headerValue}; client_credentials:
-- {clientId, clientSecret, tokenEndpoint, scope?, accessToken?, expiresAt?};
-- oauth: {clientId, clientSecret?, authorizationEndpoint, tokenEndpoint,
-- registrationClientUri?, accessToken, refreshToken?, scope?}) — so adding a
-- future auth type never needs another migration. auth_ciphertext (the
-- original bearer field) stays as-is for auth_type='bearer'; existing rows
-- are backfilled from it.
ALTER TABLE connections ADD COLUMN auth_type TEXT NOT NULL DEFAULT 'none';
ALTER TABLE connections ADD COLUMN auth_config_ciphertext TEXT;
ALTER TABLE connections ADD COLUMN oauth_token_expires_at TEXT;
ALTER TABLE connections ADD COLUMN oauth_needs_reauth INTEGER NOT NULL DEFAULT 0;

UPDATE connections SET auth_type = 'bearer' WHERE auth_ciphertext IS NOT NULL;
