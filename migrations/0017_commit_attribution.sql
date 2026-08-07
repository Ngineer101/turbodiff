-- Commit attribution: record which signed-in user instructed each factory
-- action so sandbox commits can carry them as the git author (the bot stays
-- the committer). All columns are nullable — operator/API and auto-triggered
-- runs have no human to attribute.
ALTER TABLE plans ADD COLUMN created_by_login TEXT;
ALTER TABLE plans ADD COLUMN created_by_id INTEGER;
-- Feature author = the plan approver; coauthor = the plan creator when they
-- differ (rides the commit message as a Co-authored-by trailer).
ALTER TABLE features ADD COLUMN author_login TEXT;
ALTER TABLE features ADD COLUMN author_id INTEGER;
ALTER TABLE features ADD COLUMN coauthor_login TEXT;
ALTER TABLE features ADD COLUMN coauthor_id INTEGER;
-- cockpit_comments.author (login) predates this; the id completes the noreply
-- identity for fix commits dispatched from a comment.
ALTER TABLE cockpit_comments ADD COLUMN author_id INTEGER;
