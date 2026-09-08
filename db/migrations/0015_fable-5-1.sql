DO $block$
DECLARE
  affected_rows bigint;
  pinned_rows bigint;
BEGIN
  UPDATE "app"."models" SET model_id = 'claude-fable-5-1', label = 'Fable 5.1' WHERE provider = 'anthropic' AND model_id = 'claude-fable-5';
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows = 0 THEN
    -- The seeded Fable 5 row was deleted or renamed by an operator; insert
    -- Fable 5.1 directly so the catalog still gains the new model. Only claim
    -- runner_default when no other row holds it (models_runner_default_unique
    -- is a partial unique index on runner_default WHERE runner_default).
    INSERT INTO "app"."models" ("model_id", "provider", "label", "for_runner", "for_reviewer", "runner_default", "reviewer_default", "sort_order")
    SELECT 'claude-fable-5-1', 'anthropic', 'Fable 5.1', true, true,
           NOT EXISTS (SELECT 1 FROM "app"."models" WHERE runner_default),
           false, 0
    WHERE NOT EXISTS (SELECT 1 FROM "app"."models" WHERE provider = 'anthropic' AND model_id = 'claude-fable-5-1');
    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    RAISE LOG 'migration 0015_fable-5-1: no claude-fable-5 catalog row to rename; inserted % claude-fable-5-1 row(s)', affected_rows;
  ELSE
    RAISE LOG 'migration 0015_fable-5-1: updated % catalog row(s) to model_id=claude-fable-5-1', affected_rows;
  END IF;

  -- Rows that pinned the old id in a picker snapshot it into runner_model;
  -- they must follow the rename or recurring automations (and re-run plans /
  -- features) would keep launching the retired id.
  UPDATE "app"."plans" SET runner_model = 'claude-fable-5-1' WHERE runner_model = 'claude-fable-5';
  GET DIAGNOSTICS pinned_rows = ROW_COUNT;
  RAISE LOG 'migration 0015_fable-5-1: remapped % pinned plan row(s)', pinned_rows;
  UPDATE "app"."features" SET runner_model = 'claude-fable-5-1' WHERE runner_model = 'claude-fable-5';
  GET DIAGNOSTICS pinned_rows = ROW_COUNT;
  RAISE LOG 'migration 0015_fable-5-1: remapped % pinned feature row(s)', pinned_rows;
  UPDATE "app"."automations" SET runner_model = 'claude-fable-5-1' WHERE runner_model = 'claude-fable-5';
  GET DIAGNOSTICS pinned_rows = ROW_COUNT;
  RAISE LOG 'migration 0015_fable-5-1: remapped % pinned automation row(s)', pinned_rows;
END
$block$;
