-- Custom review agents (design: docs/custom-agents-design.md).
-- Agents are installation-scoped config rows executed by the one generic
-- PrReviewer Flue agent; built-in personas are seeded rows (is_builtin = 1)
-- created lazily per installation by ensureBuiltinAgents in src/lib/db.ts.

CREATE TABLE agents (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	installation_id INTEGER NOT NULL,
	slug TEXT NOT NULL,
	name TEXT NOT NULL,
	description TEXT,
	instructions TEXT NOT NULL,
	model TEXT NOT NULL DEFAULT 'cloudflare/anthropic/claude-sonnet-5',
	is_builtin INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	UNIQUE (installation_id, slug)
);

CREATE INDEX idx_agents_installation ON agents(installation_id);

-- Per-repo enablement for auto-review. Semantics (listEnabledAgentsForRepo):
-- no row for the built-in 'review' agent means enabled (backward compatible
-- with single-agent behavior); no row for any other agent means disabled.
CREATE TABLE repo_agents (
	repository_id INTEGER NOT NULL,
	agent_id INTEGER NOT NULL,
	enabled INTEGER NOT NULL DEFAULT 1,
	PRIMARY KEY (repository_id, agent_id)
);

-- Which agent produced a review, and the exact Flue instance id it ran as
-- (`<slug>--<owner>--<repo>--<pr>`); metering matches on the instance id
-- instead of parsing it.
ALTER TABLE reviews ADD COLUMN agent_slug TEXT;
ALTER TABLE reviews ADD COLUMN agent_instance_id TEXT;

CREATE INDEX idx_reviews_agent_instance ON reviews(agent_instance_id);
