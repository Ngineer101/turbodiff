-- Cheap live polling (perf overhaul): a single monotonic change counter the
-- client polls with one indexed read, instead of refetching full board/task/
-- feature payloads every 5 seconds. Triggers keep it honest — every write to
-- a live-UI table bumps it, so no application code path can forget to.
--
-- Deliberately global rather than per-installation: the poll answer is only
-- "something changed, refetch what you're looking at", a spurious refetch is
-- cheap, and a missed bump (the failure mode of hand-scoped bumping) would
-- silently freeze the UI.
CREATE TABLE factory_version (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	version INTEGER NOT NULL DEFAULT 1
);
INSERT INTO factory_version (id, version) VALUES (1, 1);

-- One trigger pair per table that feeds a polled payload (board, task,
-- cockpit, chat, automation runs).
CREATE TRIGGER bump_plans_i AFTER INSERT ON plans BEGIN UPDATE factory_version SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER bump_plans_u AFTER UPDATE ON plans BEGIN UPDATE factory_version SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER bump_plans_d AFTER DELETE ON plans BEGIN UPDATE factory_version SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER bump_features_i AFTER INSERT ON features BEGIN UPDATE factory_version SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER bump_features_u AFTER UPDATE ON features BEGIN UPDATE factory_version SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER bump_todos_i AFTER INSERT ON todos BEGIN UPDATE factory_version SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER bump_todos_u AFTER UPDATE ON todos BEGIN UPDATE factory_version SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER bump_todos_d AFTER DELETE ON todos BEGIN UPDATE factory_version SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER bump_verifications_i AFTER INSERT ON verifications BEGIN UPDATE factory_version SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER bump_verifications_u AFTER UPDATE ON verifications BEGIN UPDATE factory_version SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER bump_chat_messages_i AFTER INSERT ON chat_messages BEGIN UPDATE factory_version SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER bump_chat_messages_u AFTER UPDATE ON chat_messages BEGIN UPDATE factory_version SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER bump_cockpit_comments_i AFTER INSERT ON cockpit_comments BEGIN UPDATE factory_version SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER bump_cockpit_comments_u AFTER UPDATE ON cockpit_comments BEGIN UPDATE factory_version SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER bump_change_requests_i AFTER INSERT ON change_requests BEGIN UPDATE factory_version SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER bump_change_requests_u AFTER UPDATE ON change_requests BEGIN UPDATE factory_version SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER bump_cr_checks_i AFTER INSERT ON cr_checks BEGIN UPDATE factory_version SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER bump_cr_checks_u AFTER UPDATE ON cr_checks BEGIN UPDATE factory_version SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER bump_cr_comments_i AFTER INSERT ON cr_comments BEGIN UPDATE factory_version SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER bump_cr_comments_u AFTER UPDATE ON cr_comments BEGIN UPDATE factory_version SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER bump_fix_attempts_i AFTER INSERT ON fix_attempts BEGIN UPDATE factory_version SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER bump_fix_attempts_u AFTER UPDATE ON fix_attempts BEGIN UPDATE factory_version SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER bump_automation_runs_i AFTER INSERT ON automation_runs BEGIN UPDATE factory_version SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER bump_automation_runs_u AFTER UPDATE ON automation_runs BEGIN UPDATE factory_version SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER bump_agent_runs_i AFTER INSERT ON agent_runs BEGIN UPDATE factory_version SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER bump_reviews_i AFTER INSERT ON reviews BEGIN UPDATE factory_version SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER bump_reviews_u AFTER UPDATE ON reviews BEGIN UPDATE factory_version SET version = version + 1 WHERE id = 1; END;
