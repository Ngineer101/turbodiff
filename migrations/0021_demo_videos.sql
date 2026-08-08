-- Per-repo switch for verification demo videos (and the runtime auto-detect
-- that powers them). Defaults ON: the verify agent works out how to launch
-- the app by itself, so there is no config burden — this column exists to
-- opt OUT for repos where recordings add time without value (API-only,
-- libraries).
ALTER TABLE repositories ADD COLUMN demo_videos INTEGER NOT NULL DEFAULT 1;
