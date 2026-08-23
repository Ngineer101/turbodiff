-- Criteria-conflict UX (see 0037/0038): when the guard interrupts, the
-- factory drafts a proposed rewrite of the acceptance criteria from the
-- human's comments and the implemented behavior, so the decision card
-- presents an approvable proposal instead of a blank authoring task.
ALTER TABLE features ADD COLUMN proposed_acceptance TEXT;
