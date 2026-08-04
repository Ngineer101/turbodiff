-- Opt-in blocking mode: when set, reviews with a P1 finding post as
-- REQUEST_CHANGES and clean reviews as APPROVE; off keeps plain comments.
ALTER TABLE repositories ADD COLUMN blocking_reviews INTEGER NOT NULL DEFAULT 0;
