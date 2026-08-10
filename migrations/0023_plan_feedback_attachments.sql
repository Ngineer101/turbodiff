-- Plan review feedback: snippet-anchored comments collected in the UI and
-- submitted as one batch; the refine run consumes them to revise the draft.
ALTER TABLE plans ADD COLUMN feedback TEXT;
-- User-attached context files (pdf/images) uploaded at start, stored in R2,
-- and downloaded into the planning sandbox for analysis.
ALTER TABLE plans ADD COLUMN attachments TEXT;
