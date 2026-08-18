-- Repo-scoped MCP attachment, replacing the per-agent model: a connection in
-- the installation-level registry is attached to a repository, and every
-- action on that repository mounts it — hosted PR reviews and sandbox
-- automation runs, each behind its own toggle so a connection can be limited
-- to one context.
CREATE TABLE repo_connections (
	repository_id INTEGER NOT NULL,
	connection_id INTEGER NOT NULL,
	reviews INTEGER NOT NULL DEFAULT 1, -- mount into hosted PR reviews
	automations INTEGER NOT NULL DEFAULT 1, -- mount into sandbox automation runs
	PRIMARY KEY (repository_id, connection_id)
);
CREATE INDEX idx_repo_connections_connection ON repo_connections(connection_id);

-- Seed from the per-agent model. Agents run on every repo by default
-- (repo_agents rows are explicit overrides only), so the faithful mapping for
-- "this connection was mounted wherever its agents ran" is: every MCP
-- connection with at least one agent link attaches to every enabled repo of
-- its installation.
INSERT OR IGNORE INTO repo_connections (repository_id, connection_id)
SELECT r.id, c.id
FROM connections c
JOIN repositories r ON r.installation_id = c.installation_id AND r.enabled = 1
WHERE c.kind = 'mcp'
	AND EXISTS (SELECT 1 FROM agent_connection_links l WHERE l.connection_id = c.id);

DROP TABLE agent_connection_links;
