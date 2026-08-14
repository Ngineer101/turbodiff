-- Cost/token metering for the rest of the factory pipeline (mirrors
-- 0003_review_usage.sql's columns on reviews). Each of these rows is one CLI
-- run per attempt, not an accumulator like reviews' per-turn additions — the
-- parsed `claude --output-format json` usage is written once, on completion.

ALTER TABLE features ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE features ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE features ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE features ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE features ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE features ADD COLUMN model TEXT;

ALTER TABLE fix_attempts ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE fix_attempts ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE fix_attempts ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE fix_attempts ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE fix_attempts ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE fix_attempts ADD COLUMN model TEXT;

ALTER TABLE verifications ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE verifications ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE verifications ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE verifications ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE verifications ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE verifications ADD COLUMN model TEXT;

ALTER TABLE automation_runs ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE automation_runs ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE automation_runs ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE automation_runs ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE automation_runs ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE automation_runs ADD COLUMN model TEXT;
