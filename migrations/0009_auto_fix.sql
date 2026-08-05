-- Opt-in auto-fix: when a blocking (CHANGES_REQUESTED) turbodiff review lands
-- on a PR, dispatch the fix agent to address the findings automatically.
ALTER TABLE repositories ADD COLUMN auto_fix INTEGER NOT NULL DEFAULT 0;

-- One row per fix-agent run. The per-PR row count enforces the iteration cap
-- (a fix push triggers a re-review, which may trigger another fix — the cap
-- guarantees the loop terminates and hands off to a human).
CREATE TABLE fix_attempts (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
	pr_number INTEGER NOT NULL,
	"trigger" TEXT NOT NULL, -- blocking_review | manual
	status TEXT NOT NULL DEFAULT 'running', -- running | fixed | no_changes | tests_failed | failed
	commit_sha TEXT,
	error TEXT,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_fix_attempts_pr ON fix_attempts (repository_id, pr_number);
