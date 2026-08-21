-- Native change requests (docs/artifacts-provider.md): the forge layer for
-- Artifacts-hosted repos. A CR is turbodiff's own pull request — rows here,
-- diffs in R2 (crs/ prefix, private), git mechanics in the sandbox
-- (src/ai/runtime/cr-engine.ts).
CREATE TABLE change_requests (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	repository_id INTEGER NOT NULL,
	-- Per-repo display sequence ("CR #3"), allocated on insert.
	number INTEGER NOT NULL,
	-- The factory feature that opened it, when factory-opened.
	feature_id INTEGER,
	title TEXT NOT NULL,
	source_branch TEXT NOT NULL,
	target_branch TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'open', -- 'open' | 'merged' | 'closed'
	source_head TEXT,
	target_head TEXT,
	merge_base TEXT,
	mergeable INTEGER, -- NULL unknown, 1 clean, 0 conflicts
	conflict_files TEXT, -- JSON string[]
	files TEXT, -- JSON CrFileChange[] summary
	diff_key TEXT, -- R2 key of the cached unified patch
	patch_truncated INTEGER NOT NULL DEFAULT 0,
	review_status TEXT, -- NULL none yet | 'approved' | 'changes_requested'
	merged_head TEXT,
	opened_by TEXT NOT NULL DEFAULT 'factory', -- 'factory' | 'operator' | login
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_change_requests_repo_number ON change_requests (repository_id, number);
CREATE INDEX idx_change_requests_repo_status ON change_requests (repository_id, status);
-- One open CR per (repo, source, target); reopening refreshes instead.
CREATE UNIQUE INDEX idx_change_requests_open_branches
	ON change_requests (repository_id, source_branch, target_branch)
	WHERE status = 'open';

-- Review findings and human comments, anchored to the diff's new side.
CREATE TABLE cr_comments (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	change_request_id INTEGER NOT NULL,
	file TEXT, -- NULL = change-request-level comment
	line INTEGER,
	author TEXT NOT NULL, -- 'turbodiff[bot]' or a user login
	kind TEXT NOT NULL DEFAULT 'comment', -- 'comment' | 'finding' | 'summary'
	severity TEXT, -- findings: 'P1' | 'P2' | 'P3'
	body TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_cr_comments_cr ON cr_comments (change_request_id);

-- Native check runs (turbodiff's own CI): the repo's check command, the
-- review verdict, and the verification pass each record one row per run.
CREATE TABLE cr_checks (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	change_request_id INTEGER NOT NULL,
	name TEXT NOT NULL, -- 'check' | 'review' | 'verify'
	status TEXT NOT NULL, -- 'running' | 'passed' | 'failed' | 'error'
	summary TEXT,
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One live row per check name; runs overwrite in place (status history is
-- not a v1 concern).
CREATE UNIQUE INDEX idx_cr_checks_cr_name ON cr_checks (change_request_id, name);

-- Factory features link to the CR they opened (GitHub features keep using
-- pr_number alone).
ALTER TABLE features ADD COLUMN change_request_id INTEGER;
