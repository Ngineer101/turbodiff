ALTER TABLE "app"."reviews" ADD COLUMN "stage_run_id" bigint;--> statement-breakpoint
ALTER TABLE "app"."reviews" ADD COLUMN "verdict" text;--> statement-breakpoint
ALTER TABLE "app"."reviews" ADD CONSTRAINT "reviews_stage_run_id_stage_runs_id_fk" FOREIGN KEY ("stage_run_id") REFERENCES "app"."stage_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reviews_stage_run_idx" ON "app"."reviews" USING btree ("stage_run_id","id") WHERE (stage_run_id IS NOT NULL);--> statement-breakpoint
ALTER TABLE "app"."reviews" ADD CONSTRAINT "reviews_verdict_check" CHECK ((verdict IS NULL) OR (verdict = ANY (ARRAY['approve'::text, 'comment'::text, 'request_changes'::text])));