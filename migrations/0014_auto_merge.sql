-- Opt-in auto-merge for factory PRs (docs/software-factory-design.md, Phase 5).
-- Trust is earned, not configured: off by default, and even when on, a PR only
-- merges when the empirical verification passed AND the review is clean — the
-- factory declines to merge on any ambiguity and leaves it to a human.
ALTER TABLE repositories ADD COLUMN auto_merge INTEGER NOT NULL DEFAULT 0;
