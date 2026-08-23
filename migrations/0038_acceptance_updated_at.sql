-- Criteria-conflict guard, corrected (see 0037): the guard must only fire
-- when the failing criteria PREDATE the human's comment-driven fix. Once the
-- user updates the criteria, the contract is re-aligned and verification
-- failures go back to the normal fix path instead of re-raising the flag.
ALTER TABLE features ADD COLUMN acceptance_updated_at TEXT;
