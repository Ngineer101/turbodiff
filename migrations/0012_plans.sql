-- Phase 3 of the software factory (docs/software-factory-design.md): a plan is
-- the front half of the pipeline. A user submits requirements; the planning
-- agent analyzes the repo, asks clarifying questions, and (after answers)
-- produces an implementation plan plus machine-checkable acceptance criteria.
-- On approval the plan becomes a feature and flows into generation.
CREATE TABLE plans (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
	title TEXT NOT NULL,
	requirements TEXT NOT NULL, -- the user's initial free-form input
	analysis TEXT,             -- the agent's grounding analysis (markdown)
	questions TEXT,            -- clarifying questions, JSON array of strings
	answers TEXT,              -- the user's answers, JSON array of strings
	plan TEXT,                 -- the implementation plan (markdown)
	acceptance TEXT,           -- acceptance criteria, JSON array of strings
	feature_id INTEGER REFERENCES features(id) ON DELETE SET NULL,
	status TEXT NOT NULL DEFAULT 'analyzing',
	-- analyzing | awaiting_answers | refining | plan_ready | approved | failed
	error TEXT,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_plans_repo ON plans (repository_id);
