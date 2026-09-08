DO $block$
DECLARE
  affected_rows bigint;
BEGIN
  UPDATE "app"."models" SET model_id = 'claude-fable-5-1', label = 'Fable 5.1' WHERE provider = 'anthropic' AND model_id = 'claude-fable-5';
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows = 0 THEN
    RAISE WARNING 'migration 0015_fable-5-1: no rows matched provider=anthropic model_id=claude-fable-5; catalog was not updated';
  ELSE
    RAISE LOG 'migration 0015_fable-5-1: updated % row(s) to model_id=claude-fable-5-1', affected_rows;
  END IF;
END
$block$;
