-- Kanban board backlog: a todo is a lightweight card (title + notes) that
-- becomes a real plan when started (plan_id links the lifecycle; the board
-- then shows the plan instead). Deletable only while unstarted.
CREATE TABLE todos (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	installation_id INTEGER NOT NULL,
	title TEXT NOT NULL,
	notes TEXT,
	created_by_login TEXT,
	created_by_id INTEGER,
	plan_id INTEGER,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Started tasks can't be deleted, only archived (hidden from the board).
ALTER TABLE plans ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;

-- Central integrations registry: connections live at the installation level
-- and agents attach to them, replacing the old per-agent agent_connections.
-- kind 'mcp' mounts as agent tools; kind 'api' stores a bearer-auth HTTP
-- integration (not agent-mountable).
CREATE TABLE connections (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	installation_id INTEGER NOT NULL,
	name TEXT NOT NULL,
	kind TEXT NOT NULL DEFAULT 'mcp',
	url TEXT NOT NULL,
	tool_allowlist TEXT,
	auth_ciphertext TEXT,
	optional INTEGER NOT NULL DEFAULT 1,
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	UNIQUE (installation_id, name)
);

CREATE TABLE agent_connection_links (
	agent_id INTEGER NOT NULL,
	connection_id INTEGER NOT NULL,
	PRIMARY KEY (agent_id, connection_id)
);

-- Migrate existing per-agent connections into the registry. Names were only
-- unique per agent; INSERT OR IGNORE keeps the first on an installation-level
-- name collision, and links are rebuilt by (installation, name) match.
INSERT OR IGNORE INTO connections (installation_id, name, kind, url, tool_allowlist, auth_ciphertext, optional, created_at)
SELECT a.installation_id, ac.name, 'mcp', ac.url, ac.tool_allowlist, ac.auth_ciphertext, ac.optional, ac.created_at
FROM agent_connections ac
JOIN agents a ON a.id = ac.agent_id;

INSERT OR IGNORE INTO agent_connection_links (agent_id, connection_id)
SELECT ac.agent_id, c.id
FROM agent_connections ac
JOIN agents a ON a.id = ac.agent_id
JOIN connections c ON c.installation_id = a.installation_id AND c.name = ac.name;

DROP TABLE agent_connections;
