-- Phase 2 of the software factory (docs/software-factory-design.md): a feature
-- is a spec that the generator turns into a branch + PR; the existing review
-- and auto-fix loop take over from there.
CREATE TABLE features (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
	title TEXT NOT NULL,
	spec TEXT NOT NULL,
	branch TEXT,
	pr_number INTEGER,
	status TEXT NOT NULL DEFAULT 'queued', -- queued | generating | pr_opened | no_changes | failed
	error TEXT,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_features_repo ON features (repository_id);
