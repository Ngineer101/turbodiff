ALTER TABLE "app"."models" ADD COLUMN "runner_fast_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "app"."models"
SET "runner_fast_default" = true
WHERE "id" = (
	SELECT "id"
	FROM "app"."models"
	WHERE "enabled" AND "for_runner"
	ORDER BY
		CASE
			WHEN "provider" = 'anthropic' AND "model_id" = 'claude-haiku-4.5' THEN 0
			WHEN "runner_default" THEN 1
			ELSE 2
		END,
		"sort_order",
		"id"
	LIMIT 1
);--> statement-breakpoint
UPDATE "app"."plans"
SET "runner_model" = (
	SELECT CASE
		WHEN "model_id" LIKE '@cf/%' THEN "model_id"
		ELSE "provider" || '/' || "model_id"
	END
	FROM "app"."models"
	WHERE "enabled" AND "for_runner" AND "runner_default"
	LIMIT 1
)
WHERE "runner_model" IS NULL;--> statement-breakpoint
UPDATE "app"."features"
SET "runner_model" = (
	SELECT CASE
		WHEN "model_id" LIKE '@cf/%' THEN "model_id"
		ELSE "provider" || '/' || "model_id"
	END
	FROM "app"."models"
	WHERE "enabled" AND "for_runner" AND "runner_default"
	LIMIT 1
)
WHERE "runner_model" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "models_runner_fast_default_unique" ON "app"."models" USING btree ("runner_fast_default") WHERE runner_fast_default;
