-- Demo recordings: the verifier records a short screen capture (WebM) of the
-- feature's happy path. The R2 key is stored as JSON {"video": key}; the
-- factory PR cockpit signs it at render time and plays it natively.
ALTER TABLE verifications ADD COLUMN demo TEXT;
