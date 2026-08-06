-- Phase 4 (docs/software-factory-design.md): empirical verification of factory
-- PRs. After generation, a verify run checks each acceptance criterion against
-- the checked-out branch — static criteria by reading the tree, runtime
-- criteria by launching the app — and captures screenshots as evidence.

-- How to launch the repo's app inside the sandbox for runtime/visual checks.
-- NULL disables runtime verification (static checks still run).
ALTER TABLE repositories ADD COLUMN run_command TEXT;
ALTER TABLE repositories ADD COLUMN app_port INTEGER;

-- Structured acceptance criteria (JSON array of strings), populated by plan
-- approval; the verifier checks against these rather than re-parsing the spec.
ALTER TABLE features ADD COLUMN acceptance TEXT;

CREATE TABLE verifications (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
	status TEXT NOT NULL DEFAULT 'running', -- running | passed | failed | error | skipped
	results TEXT, -- JSON: [{index, verdict, note, screenshot?}]
	summary TEXT, -- agent's "how it works" narrative for the PR comment
	error TEXT,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_verifications_feature ON verifications (feature_id);
