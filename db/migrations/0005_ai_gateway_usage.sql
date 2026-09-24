CREATE TABLE "app"."ai_gateway_usage" (
	"log_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"agent_run_id" bigint NOT NULL,
	"tokens_in" bigint DEFAULT 0 NOT NULL,
	"tokens_out" bigint DEFAULT 0 NOT NULL,
	"cost_usd" numeric(20, 10),
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reconciled_at" timestamp with time zone,
	CONSTRAINT "ai_gateway_usage_values_check" CHECK (tokens_in >= 0 AND tokens_out >= 0 AND (cost_usd IS NULL OR cost_usd >= 0) AND attempts >= 0)
);
--> statement-breakpoint
ALTER TABLE "app"."ai_gateway_usage" ADD CONSTRAINT "ai_gateway_usage_agent_run_id_organization_id_agent_runs_id_organization_id_fk" FOREIGN KEY ("agent_run_id","organization_id") REFERENCES "app"."agent_runs"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_gateway_usage_pending_idx" ON "app"."ai_gateway_usage" USING btree ("reconciled_at","next_attempt_at");--> statement-breakpoint
CREATE INDEX "ai_gateway_usage_agent_run_idx" ON "app"."ai_gateway_usage" USING btree ("agent_run_id");--> statement-breakpoint
-- Existing values came from each coding harness's bundled price table and
-- cannot be safely attributed to Cloudflare logs retroactively. From this
-- migration onward, cost_usd is populated only from reconciled Gateway logs.
UPDATE "app"."agent_runs" SET "cost_usd" = 0;
