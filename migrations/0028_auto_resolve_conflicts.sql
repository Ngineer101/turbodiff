-- Opt-in agent-driven conflict resolution for factory PRs. Off by default —
-- same trust model as auto_fix/auto_merge: this pushes a merge commit
-- automatically and relies on the normal review/verification gates to catch
-- a wrong resolution, rather than requiring extra human sign-off up front.
ALTER TABLE repositories ADD COLUMN auto_resolve_conflicts INTEGER NOT NULL DEFAULT 0;
