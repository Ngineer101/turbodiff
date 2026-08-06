-- Cockpit review comments (v2): line-anchored comments left in turbodiff's own
-- diff viewer. Submitting one dispatches the fix agent against that exact
-- finding — the cockpit replaces GitHub review threads as the fix channel for
-- factory PRs.
CREATE TABLE cockpit_comments (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
	path TEXT NOT NULL,
	line INTEGER NOT NULL,
	side TEXT NOT NULL DEFAULT 'additions', -- additions | deletions
	body TEXT NOT NULL,
	author TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'open', -- open | dispatched
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_cockpit_comments_feature ON cockpit_comments (feature_id);
