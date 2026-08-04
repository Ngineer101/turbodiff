-- Opt-in re-review on push: when set, pull_request synchronize events
-- re-dispatch the repo's tiered agents (debounced; see handlePullRequest).
ALTER TABLE repositories ADD COLUMN review_on_push INTEGER NOT NULL DEFAULT 0;
