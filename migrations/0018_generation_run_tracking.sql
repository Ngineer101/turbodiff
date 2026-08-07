-- When the current generation run (or run attempt) started. Lets the API
-- lazily sweep features stranded in 'generating' — a queue-consumer
-- wall-clock kill dies without ever reaching the failure handler, so the row
-- otherwise sits "generating" forever.
ALTER TABLE features ADD COLUMN run_started_at TEXT;
