-- Multi-repository tasks: a todo/plan can target 1-3 repos (same GitHub App
-- installation only). Both join tables persist the selection order so
-- position 0 stays the "primary" repo (plans.repository_id keeps that exact
-- meaning, unchanged). features.plan_id replaces plans.feature_id as the
-- source of truth for "which features came from this plan," since a plan can
-- now own more than one feature; plans.feature_id is kept, still set to the
-- primary repo's feature, for single-repo read paths.
CREATE TABLE todo_repositories (
	todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
	repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
	position INTEGER NOT NULL,
	PRIMARY KEY (todo_id, repository_id)
);

CREATE TABLE plan_repositories (
	plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
	repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
	position INTEGER NOT NULL,
	PRIMARY KEY (plan_id, repository_id)
);

INSERT INTO plan_repositories (plan_id, repository_id, position)
SELECT id, repository_id, 0 FROM plans;

ALTER TABLE features ADD COLUMN plan_id INTEGER REFERENCES plans(id) ON DELETE SET NULL;
CREATE INDEX idx_features_plan ON features (plan_id);

UPDATE features SET plan_id = (SELECT id FROM plans WHERE plans.feature_id = features.id);
