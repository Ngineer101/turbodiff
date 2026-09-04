ALTER TABLE "app"."skills" ADD COLUMN "files" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."skills" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "app"."skills" ADD COLUMN "source_ref" text;--> statement-breakpoint
ALTER TABLE "app"."skills" ADD COLUMN "source_hash" text;--> statement-breakpoint
ALTER TABLE "app"."skills" ADD COLUMN "imported_at" timestamp with time zone;