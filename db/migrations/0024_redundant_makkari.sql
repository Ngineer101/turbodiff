ALTER TABLE "app"."automations" ADD COLUMN "created_by_login" text;--> statement-breakpoint
ALTER TABLE "app"."automations" ADD COLUMN "created_by_id" bigint;--> statement-breakpoint
ALTER TABLE "app"."connections" ADD COLUMN "created_by_login" text;--> statement-breakpoint
ALTER TABLE "app"."connections" ADD COLUMN "created_by_id" bigint;--> statement-breakpoint
ALTER TABLE "app"."plans" ADD COLUMN "created_by_login" text;--> statement-breakpoint
ALTER TABLE "app"."plans" ADD COLUMN "created_by_id" bigint;
