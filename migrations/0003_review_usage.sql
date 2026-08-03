-- Per-review token usage and cost, accumulated by the observe() metering
-- subscriber in src/lib/metering.ts as each model turn completes. Costs are
-- USD estimates from Flue's model catalog rates. Rows predating tracking
-- keep zeros and render as "—" in the dashboard.

ALTER TABLE reviews ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reviews ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reviews ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reviews ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reviews ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE reviews ADD COLUMN model TEXT;
