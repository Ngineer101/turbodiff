-- Turbodiff multi-tenant config store.
-- installations/repositories mirror GitHub App installation state and are
-- kept in sync by the /webhooks/github handler; `enabled` and `model` are
-- Turbodiff's own per-repo settings (edited via the settings UI).

CREATE TABLE installations (
	id INTEGER PRIMARY KEY, -- GitHub installation id
	account_login TEXT NOT NULL,
	account_id INTEGER NOT NULL,
	account_type TEXT NOT NULL, -- 'Organization' | 'User'
	suspended INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE repositories (
	id INTEGER PRIMARY KEY, -- GitHub repository id
	installation_id INTEGER NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
	owner TEXT NOT NULL,
	name TEXT NOT NULL,
	enabled INTEGER NOT NULL DEFAULT 1,
	model TEXT, -- optional per-repo model override; NULL = deployment default
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_repositories_owner_name ON repositories(owner, name);
CREATE INDEX idx_repositories_installation ON repositories(installation_id);

-- One row per dispatched review; also backs the per-installation daily cap.
CREATE TABLE reviews (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	repository_id INTEGER NOT NULL,
	installation_id INTEGER NOT NULL,
	pr_number INTEGER NOT NULL,
	trigger_event TEXT NOT NULL, -- 'opened' | 'ready_for_review' | 'manual'
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_reviews_installation_time ON reviews(installation_id, created_at);
