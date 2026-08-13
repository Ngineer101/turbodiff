-- Recurring per-repo prompt runs (docs/software-factory-design.md engine,
-- clock-driven instead of event-driven). One automation belongs to exactly
-- one repo. Scheduling is poll-based (see src/lib/automation-schedule.ts +
-- the `scheduled` handler in src/cloudflare.ts): a fixed Cron Trigger finds
-- rows with next_run_at <= now, claims them (advances next_run_at in the
-- same statement), and enqueues a run.
CREATE TABLE automations (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	prompt TEXT NOT NULL,
	schedule_kind TEXT NOT NULL, -- 'hourly' | 'daily' | 'weekly'
	time_of_day TEXT, -- 'HH:MM' UTC; required for daily/weekly, null for hourly
	day_of_week INTEGER, -- 0 (Sun) - 6 (Sat); required for weekly, null otherwise
	enabled INTEGER NOT NULL DEFAULT 1,
	next_run_at TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_automations_repository ON automations(repository_id);
CREATE INDEX idx_automations_next_run ON automations(next_run_at) WHERE enabled = 1;

-- One row per firing, including no-op ones (every scheduled run is logged so
-- users can confirm the schedule is executing) — mirrors fix_attempts.
CREATE TABLE automation_runs (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	automation_id INTEGER NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
	status TEXT NOT NULL DEFAULT 'running', -- running | pr_opened | no_changes | checks_failed | failed
	pr_number INTEGER,
	commit_sha TEXT,
	error TEXT,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_automation_runs_automation ON automation_runs(automation_id, created_at);

-- Full session log linkage (mirrors plan_id/feature_id/fix_attempt_id on
-- agent_runs — exactly one owner column is set per row).
ALTER TABLE agent_runs ADD COLUMN automation_run_id INTEGER REFERENCES automation_runs(id) ON DELETE CASCADE;
CREATE INDEX idx_agent_runs_automation_run ON agent_runs (automation_run_id);
