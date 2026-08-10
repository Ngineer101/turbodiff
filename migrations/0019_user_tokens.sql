-- Durable per-user GitHub credentials: the OAuth refresh token (encrypted
-- with TOKEN_ENCRYPTION_KEY, like agent-connection tokens), captured at
-- sign-in. Lets async factory runs mint a fresh user access token at
-- PR-open time so the PR is opened BY the instructing user, not the bot.
CREATE TABLE user_tokens (
	user_id INTEGER PRIMARY KEY,
	login TEXT NOT NULL,
	refresh_ciphertext TEXT NOT NULL,
	updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
