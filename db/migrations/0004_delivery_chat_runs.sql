ALTER TABLE "app"."delivery_messages" ADD COLUMN "factory_run_id" bigint;--> statement-breakpoint
ALTER TABLE "app"."delivery_messages" ADD COLUMN "outcome" text;--> statement-breakpoint
ALTER TABLE "app"."delivery_messages" ADD COLUMN "commit_sha" text;--> statement-breakpoint
ALTER TABLE "app"."delivery_messages" ADD CONSTRAINT "delivery_messages_factory_run_id_organization_id_factory_runs_id_organization_id_fk" FOREIGN KEY ("factory_run_id","organization_id") REFERENCES "app"."factory_runs"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."delivery_messages" ADD CONSTRAINT "delivery_messages_run_role_unique" UNIQUE("factory_run_id","role");--> statement-breakpoint
ALTER TABLE "app"."delivery_messages" ADD CONSTRAINT "delivery_messages_outcome_check" CHECK (outcome IS NULL OR outcome IN ('changed', 'no_changes'));