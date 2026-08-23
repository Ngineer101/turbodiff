-- Criteria-conflict guard (docs/artifacts-provider.md): when verification
-- fails against code whose latest fix came from a human cockpit comment, the
-- factory must not auto-revert the human's direction — it flags the conflict
-- and waits for an explicit decision (update the criteria, or restore the
-- planned behavior).
ALTER TABLE features ADD COLUMN criteria_conflict INTEGER NOT NULL DEFAULT 0;
