-- Per-task model choice for sandboxed Claude Code runs. Set on the plan when
-- the task starts (or updated later), snapshotted onto each feature at
-- approval so generation/fix runs read it without a join. NULL = the default
-- (see DEFAULT_RUNNER_MODEL in src/shared/runner-models.ts). Distinct from
-- features.model, which records the model a finished run actually used.
ALTER TABLE plans ADD COLUMN runner_model TEXT;
ALTER TABLE features ADD COLUMN runner_model TEXT;
