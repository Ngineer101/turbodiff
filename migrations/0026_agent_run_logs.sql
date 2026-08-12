-- Full agent-session logs (docs/software-factory-design.md): a pointer row
-- per completed sandboxed agent-CLI invocation (plan analyze, plan refine,
-- generate, verify, fix), with the full stdout+stderr stored in R2 under
-- log_key. Exactly one of plan_id/feature_id/fix_attempt_id is set per row,
-- matching which call site produced it.
CREATE TABLE agent_runs (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	kind TEXT NOT NULL, -- plan_analyze | plan_refine | generate | verify | fix
	plan_id INTEGER REFERENCES plans(id) ON DELETE CASCADE,
	feature_id INTEGER REFERENCES features(id) ON DELETE CASCADE,
	fix_attempt_id INTEGER REFERENCES fix_attempts(id) ON DELETE CASCADE,
	log_key TEXT NOT NULL, -- R2 key in the ARTIFACTS bucket
	success INTEGER NOT NULL, -- 1 if the agent process exited 0
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_agent_runs_plan ON agent_runs (plan_id);
CREATE INDEX idx_agent_runs_feature ON agent_runs (feature_id);
CREATE INDEX idx_agent_runs_fix_attempt ON agent_runs (fix_attempt_id);
