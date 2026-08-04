-- External MCP tool connections per agent (Phase 2 of
-- docs/custom-agents-design.md). Each row is one remote MCP server the
-- agent mounts at run time — e.g. a tenant's Executor catalog endpoint.
-- Bearer tokens are sealed with AES-256-GCM (src/lib/crypto.ts, key in the
-- TOKEN_ENCRYPTION_KEY Worker secret) and are write-only in the UI.

CREATE TABLE agent_connections (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	agent_id INTEGER NOT NULL,
	name TEXT NOT NULL, -- server name: tools mount as mcp__<name>__<tool>
	url TEXT NOT NULL,
	tool_allowlist TEXT, -- JSON string array; NULL = every tool the server lists
	auth_ciphertext TEXT, -- sealed bearer token; NULL = unauthenticated server
	optional INTEGER NOT NULL DEFAULT 1, -- 1: agent runs without the server if it fails
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	UNIQUE (agent_id, name)
);

CREATE INDEX idx_agent_connections_agent ON agent_connections(agent_id);
