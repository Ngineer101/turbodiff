-- Review lifecycle tracking for the /reviews activity page.
-- New dispatches insert with status 'running'; the post_review tool flips the
-- row to 'completed' when the agent publishes to GitHub. Pre-existing rows
-- predate tracking, so they default to 'completed'.

ALTER TABLE reviews ADD COLUMN status TEXT NOT NULL DEFAULT 'completed';
ALTER TABLE reviews ADD COLUMN completed_at TEXT;
ALTER TABLE reviews ADD COLUMN review_url TEXT;

CREATE INDEX idx_reviews_repo_pr_status ON reviews(repository_id, pr_number, status);
