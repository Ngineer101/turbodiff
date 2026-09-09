ALTER TABLE "app"."reviews" ADD COLUMN "conclusion" text;--> statement-breakpoint
ALTER TABLE "app"."reviews" ADD COLUMN "coverage_status" text;--> statement-breakpoint
ALTER TABLE "app"."reviews" ADD COLUMN "reviewable_file_count" integer;--> statement-breakpoint
ALTER TABLE "app"."reviews" ADD COLUMN "covered_file_count" integer;--> statement-breakpoint
ALTER TABLE "app"."reviews" ADD COLUMN "missing_paths" jsonb;--> statement-breakpoint
ALTER TABLE "app"."reviews" ADD COLUMN "coverage_head_sha" text;--> statement-breakpoint
ALTER TABLE "app"."reviews" ADD COLUMN "published_head_sha" text;--> statement-breakpoint
ALTER TABLE "app"."reviews" ADD CONSTRAINT "reviews_conclusion_check" CHECK ((conclusion IS NULL) OR (conclusion = ANY (ARRAY['ready'::text, 'ready_with_warnings'::text, 'not_ready'::text, 'inconclusive'::text])));--> statement-breakpoint
ALTER TABLE "app"."reviews" ADD CONSTRAINT "reviews_coverage_status_check" CHECK ((coverage_status IS NULL) OR (coverage_status = ANY (ARRAY['complete'::text, 'incomplete'::text, 'stale'::text])));--> statement-breakpoint
ALTER TABLE "app"."reviews" ADD CONSTRAINT "reviews_coverage_counts_check" CHECK ((reviewable_file_count IS NULL AND covered_file_count IS NULL) OR
        (reviewable_file_count >= 0 AND covered_file_count >= 0 AND covered_file_count <= reviewable_file_count));--> statement-breakpoint
ALTER TABLE "app"."reviews" ADD CONSTRAINT "reviews_missing_paths_array_check" CHECK ((missing_paths IS NULL) OR (jsonb_typeof(missing_paths) = 'array'::text));