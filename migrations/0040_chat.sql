-- Cockpit chat: a conversational channel with the fix-sandbox coding agent
-- for small iterative changes to a factory PR. One row per message; a user
-- message's status tracks its turn ('queued' → 'running' → 'done'|'failed').
CREATE TABLE chat_messages (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
	role TEXT NOT NULL, -- user | assistant
	body TEXT NOT NULL,
	author TEXT, -- login for user messages; NULL for assistant
	author_id INTEGER, -- GitHub/native user id for commit attribution
	status TEXT NOT NULL DEFAULT 'done', -- queued | running | done | failed (user rows)
	outcome TEXT, -- assistant rows: changed | no_changes | tests_failed
	commit_sha TEXT, -- assistant rows: the pushed commit, when outcome = 'changed'
	error TEXT, -- user rows that failed: short scrubbed reason
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_chat_messages_feature ON chat_messages (feature_id);

-- Resumable Claude CLI session for this feature's chat (claude -p --resume).
-- Best-effort: lost when the sandbox sleeps; the runner falls back to a
-- fresh session primed with recent chat history.
ALTER TABLE features ADD COLUMN chat_session_id TEXT;
