-- Durable read-side state used to keep interactive requests off GitHub and
-- Artifacts git mirrors. Membership snapshots are refreshed from GitHub with
-- bounded staleness; ref heads are advanced by durable Artifacts push events.

CREATE TABLE user_installation_access (
	user_id TEXT PRIMARY KEY,
	installation_ids TEXT NOT NULL,
	verified_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE repository_refs (
	repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
	ref TEXT NOT NULL,
	head_sha TEXT NOT NULL,
	pushed_at TEXT NOT NULL,
	PRIMARY KEY (repository_id, ref)
);

CREATE INDEX idx_repository_refs_head
	ON repository_refs (repository_id, head_sha);

CREATE TABLE installation_repo_sync (
	installation_id INTEGER PRIMARY KEY REFERENCES installations(id) ON DELETE CASCADE,
	last_synced_at TEXT,
	syncing_until TEXT
);

-- The board's backlog query scopes on installation and excludes planned
-- todos. Without this partial index it becomes a full scan as history grows.
CREATE INDEX idx_todos_installation_unplanned
	ON todos (installation_id, id DESC)
	WHERE plan_id IS NULL;

-- Feature lookups by PR number are a frequent webhook/request path.
CREATE INDEX idx_features_repository_pr
	ON features (repository_id, pr_number, id DESC)
	WHERE pr_number IS NOT NULL;

-- 0042's live counter predates server-side board snapshots. These relation
-- tables also shape /api/board, so every mutation must advance the snapshot
-- key; otherwise a repo toggle or link edit can keep returning a cached old
-- board even after the client correctly invalidates its query.
CREATE TRIGGER bump_installations_perf_i AFTER INSERT ON installations BEGIN UPDATE factory_version SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER bump_installations_perf_u AFTER UPDATE ON installations BEGIN UPDATE factory_version SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER bump_installations_perf_d AFTER DELETE ON installations BEGIN UPDATE factory_version SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER bump_repositories_perf_i AFTER INSERT ON repositories BEGIN UPDATE factory_version SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER bump_repositories_perf_u AFTER UPDATE ON repositories BEGIN UPDATE factory_version SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER bump_repositories_perf_d AFTER DELETE ON repositories BEGIN UPDATE factory_version SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER bump_todo_repositories_perf_i AFTER INSERT ON todo_repositories BEGIN UPDATE factory_version SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER bump_todo_repositories_perf_u AFTER UPDATE ON todo_repositories BEGIN UPDATE factory_version SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER bump_todo_repositories_perf_d AFTER DELETE ON todo_repositories BEGIN UPDATE factory_version SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER bump_plan_repositories_perf_i AFTER INSERT ON plan_repositories BEGIN UPDATE factory_version SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER bump_plan_repositories_perf_u AFTER UPDATE ON plan_repositories BEGIN UPDATE factory_version SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER bump_plan_repositories_perf_d AFTER DELETE ON plan_repositories BEGIN UPDATE factory_version SET version = version + 1 WHERE id = 1; END;

-- 0042 covered the common insert/update paths, but hard deletion must also
-- wake clients and invalidate board snapshots.
CREATE TRIGGER bump_features_perf_d AFTER DELETE ON features BEGIN UPDATE factory_version SET version = version + 1 WHERE id = 1; END;
