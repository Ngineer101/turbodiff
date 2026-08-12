-- Per-user coding-agent runner credentials (bring-your-own subscription):
-- a signed-in user can store their own Claude/Codex auth so factory runs
-- they trigger spend it instead of the Worker-level secrets. Sealed with
-- TOKEN_ENCRYPTION_KEY (crypto.ts sealToken), same pattern as user_tokens
-- (migration 0019) and connections (migration 0022). One row per
-- (user_id, runner); auth_mode picks how that runner is authenticated.
CREATE TABLE runner_credentials (
	user_id INTEGER NOT NULL,
	runner TEXT NOT NULL,             -- 'claude' | 'codex'
	auth_mode TEXT NOT NULL,          -- 'subscription' | 'gateway' | 'api_key'
	secret_ciphertext TEXT NOT NULL,  -- sealed OAuth token / API key / auth.json
	base_url TEXT,                    -- gateway mode only: the provider-compatible endpoint
	tos_acknowledged_at TEXT,         -- set only for modes flagged ToS-uncertain (codex subscription)
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	updated_at TEXT NOT NULL DEFAULT (datetime('now')),
	PRIMARY KEY (user_id, runner)
);
