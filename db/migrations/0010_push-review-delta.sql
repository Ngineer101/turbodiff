ALTER TABLE "app"."repositories" ADD COLUMN "review_push_debounce_minutes" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."reviews" ADD COLUMN "head_sha" text;--> statement-breakpoint
ALTER TABLE "app"."reviews" ADD COLUMN "finding_paths" jsonb;--> statement-breakpoint
ALTER TABLE "app"."repositories" ADD CONSTRAINT "repositories_review_push_debounce_check" CHECK ((review_push_debounce_minutes >= 0) AND (review_push_debounce_minutes <= 720));--> statement-breakpoint
ALTER TABLE "app"."reviews" ADD CONSTRAINT "reviews_finding_paths_array_check" CHECK ((finding_paths IS NULL) OR (jsonb_typeof(finding_paths) = 'array'::text));