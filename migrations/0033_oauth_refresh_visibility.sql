-- Whether an OAuth connection holds a refresh token, tracked outside the
-- sealed config blob so the integrations list can tell "access token lapsed
-- but silently refreshable" (still connected) apart from "re-auth genuinely
-- required" without decrypting. MCP servers commonly issue 10-15 minute
-- access tokens, so treating every lapse as reconnect-worthy forced users
-- through the OAuth flow constantly.
ALTER TABLE connections ADD COLUMN oauth_has_refresh_token INTEGER NOT NULL DEFAULT 0;

-- Optimistic backfill: existing connected OAuth rows almost always carry a
-- refresh token. If one doesn't, the first failed refresh sets
-- oauth_needs_reauth and the status turns red as before.
UPDATE connections
SET oauth_has_refresh_token = 1
WHERE auth_type = 'oauth' AND auth_config_ciphertext IS NOT NULL;
