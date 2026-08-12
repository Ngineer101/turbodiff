-- Links a cockpit comment to the batch fix run that addresses it, so the
-- cockpit can show a lasting outcome badge per comment instead of the old
-- static 'dispatched' label.
ALTER TABLE cockpit_comments ADD COLUMN fix_attempt_id INTEGER
	REFERENCES fix_attempts(id) ON DELETE SET NULL;
CREATE INDEX idx_cockpit_comments_fix_attempt ON cockpit_comments (fix_attempt_id);
