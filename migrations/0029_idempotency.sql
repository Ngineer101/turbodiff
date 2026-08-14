-- Database-backed idempotency for the two UI actions that fan out into paid
-- factory work. A repeated/concurrent plan approval may create at most one
-- feature per repository, and a todo may be the origin of at most one plan.

CREATE UNIQUE INDEX idx_features_plan_repo ON features(plan_id, repository_id);

ALTER TABLE plans ADD COLUMN todo_id INTEGER REFERENCES todos(id) ON DELETE SET NULL;
UPDATE plans SET todo_id = (
	SELECT id FROM todos WHERE todos.plan_id = plans.id ORDER BY id LIMIT 1
);
CREATE UNIQUE INDEX idx_plans_todo ON plans(todo_id);
