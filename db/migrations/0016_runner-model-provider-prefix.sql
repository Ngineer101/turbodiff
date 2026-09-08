-- Canonicalize the two legacy Anthropic ids used by the old Claude Code
-- harness. Delete-and-upsert avoids conflicts when an operator has already
-- added the new catalog row, while preserving all capability/default flags.
WITH old AS (
  DELETE FROM "app"."models"
  WHERE provider = 'anthropic' AND model_id = 'claude-fable-5-1'
  RETURNING *
)
INSERT INTO "app"."models"
  (model_id, provider, label, for_runner, for_reviewer, runner_default, reviewer_default, sort_order)
SELECT 'claude-fable-5.1', provider, label, for_runner, for_reviewer, runner_default, reviewer_default, sort_order
FROM old
ON CONFLICT (provider, model_id) DO UPDATE SET
  for_runner = "models".for_runner OR excluded.for_runner,
  for_reviewer = "models".for_reviewer OR excluded.for_reviewer,
  runner_default = "models".runner_default OR excluded.runner_default,
  reviewer_default = "models".reviewer_default OR excluded.reviewer_default,
  sort_order = LEAST("models".sort_order, excluded.sort_order);
--> statement-breakpoint
WITH old AS (
  DELETE FROM "app"."models"
  WHERE provider = 'anthropic' AND model_id = 'claude-haiku-4-5-20251001'
  RETURNING *
)
INSERT INTO "app"."models"
  (model_id, provider, label, for_runner, for_reviewer, runner_default, reviewer_default, sort_order)
SELECT 'claude-haiku-4.5', provider, label, for_runner, for_reviewer, runner_default, reviewer_default, sort_order
FROM old
ON CONFLICT (provider, model_id) DO UPDATE SET
  for_runner = "models".for_runner OR excluded.for_runner,
  for_reviewer = "models".for_reviewer OR excluded.for_reviewer,
  runner_default = "models".runner_default OR excluded.runner_default,
  reviewer_default = "models".reviewer_default OR excluded.reviewer_default,
  sort_order = LEAST("models".sort_order, excluded.sort_order);
--> statement-breakpoint
UPDATE "app"."agents"
SET model = CASE
  WHEN model = 'cloudflare/anthropic/claude-fable-5-1' THEN 'cloudflare/anthropic/claude-fable-5.1'
  WHEN model = 'cloudflare/anthropic/claude-haiku-4-5-20251001' THEN 'cloudflare/anthropic/claude-haiku-4.5'
  ELSE model
END
WHERE model IN (
  'cloudflare/anthropic/claude-fable-5-1',
  'cloudflare/anthropic/claude-haiku-4-5-20251001'
);
--> statement-breakpoint
-- Runner selections used to be bare Anthropic model ids because Claude Code
-- was the only harness. OpenCode addresses the Cloudflare AI Gateway catalog
-- as provider/model, so qualify existing snapshots.
UPDATE "app"."plans"
SET runner_model = CASE
  WHEN runner_model IN ('claude-fable-5-1', 'anthropic/claude-fable-5-1') THEN 'anthropic/claude-fable-5.1'
  WHEN runner_model IN ('claude-haiku-4-5-20251001', 'anthropic/claude-haiku-4-5-20251001') THEN 'anthropic/claude-haiku-4.5'
  ELSE 'anthropic/' || runner_model
END
WHERE position('/' IN runner_model) = 0
   OR runner_model IN ('anthropic/claude-fable-5-1', 'anthropic/claude-haiku-4-5-20251001');
--> statement-breakpoint
UPDATE "app"."features"
SET runner_model = CASE
  WHEN runner_model IN ('claude-fable-5-1', 'anthropic/claude-fable-5-1') THEN 'anthropic/claude-fable-5.1'
  WHEN runner_model IN ('claude-haiku-4-5-20251001', 'anthropic/claude-haiku-4-5-20251001') THEN 'anthropic/claude-haiku-4.5'
  ELSE 'anthropic/' || runner_model
END
WHERE position('/' IN runner_model) = 0
   OR runner_model IN ('anthropic/claude-fable-5-1', 'anthropic/claude-haiku-4-5-20251001');
--> statement-breakpoint
UPDATE "app"."automations"
SET runner_model = CASE
  WHEN runner_model IN ('claude-fable-5-1', 'anthropic/claude-fable-5-1') THEN 'anthropic/claude-fable-5.1'
  WHEN runner_model IN ('claude-haiku-4-5-20251001', 'anthropic/claude-haiku-4-5-20251001') THEN 'anthropic/claude-haiku-4.5'
  ELSE 'anthropic/' || runner_model
END
WHERE position('/' IN runner_model) = 0
   OR runner_model IN ('anthropic/claude-fable-5-1', 'anthropic/claude-haiku-4-5-20251001');
