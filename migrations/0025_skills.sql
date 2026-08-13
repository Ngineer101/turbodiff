-- Skills: structured, installation-scoped extra-ability configs applied to
-- code generation / fix runs (design mirrors migrations/0004_custom_agents.sql).
-- Skills are materialized as .claude/skills/<slug>/SKILL.md files inside the
-- sandboxed Claude Code CLI checkout for auto-discovery — see
-- src/lib/skill-files.ts. PR review does not consume skills (different,
-- file-system-less runtime).

CREATE TABLE skills (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	installation_id INTEGER NOT NULL,
	slug TEXT NOT NULL,
	name TEXT NOT NULL,
	description TEXT,
	instructions TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	UNIQUE (installation_id, slug)
);

CREATE INDEX idx_skills_installation ON skills(installation_id);

-- Per-repo enablement. No row = disabled (skills are opt-in per repo; there
-- is no built-in default-on skill, unlike repo_agents).
CREATE TABLE repo_skills (
	repository_id INTEGER NOT NULL,
	skill_id INTEGER NOT NULL,
	enabled INTEGER NOT NULL DEFAULT 1,
	PRIMARY KEY (repository_id, skill_id)
);
