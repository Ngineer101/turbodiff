ALTER TABLE "app"."review_patch_deliveries" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "app"."review_patch_deliveries" CASCADE;--> statement-breakpoint
ALTER TABLE "app"."models" DROP CONSTRAINT "models_reviewer_experiment_weight_check";--> statement-breakpoint
ALTER TABLE "app"."models" DROP CONSTRAINT "models_verifier_experiment_weight_check";--> statement-breakpoint
ALTER TABLE "app"."models" DROP CONSTRAINT "models_review_diff_tokens_check";--> statement-breakpoint
ALTER TABLE "app"."review_findings" DROP CONSTRAINT "review_findings_verifier_confidence_check";--> statement-breakpoint
ALTER TABLE "app"."review_findings" DROP CONSTRAINT "review_findings_verifier_severity_check";--> statement-breakpoint
ALTER TABLE "app"."reviews" DROP CONSTRAINT "reviews_candidate_count_check";--> statement-breakpoint
ALTER TABLE "app"."reviews" DROP CONSTRAINT "reviews_verification_status_check";--> statement-breakpoint
ALTER TABLE "app"."reviews" DROP CONSTRAINT "reviews_verification_input_tokens_check";--> statement-breakpoint
ALTER TABLE "app"."reviews" DROP CONSTRAINT "reviews_verification_output_tokens_check";--> statement-breakpoint
ALTER TABLE "app"."reviews" DROP CONSTRAINT "reviews_verification_cost_usd_check";--> statement-breakpoint
ALTER TABLE "app"."reviews" DROP CONSTRAINT "reviews_verification_latency_ms_check";--> statement-breakpoint
DROP INDEX "app"."reviews_submission_id_idx";--> statement-breakpoint
DROP INDEX "app"."review_findings_feedback_idx";--> statement-breakpoint
CREATE INDEX "review_findings_feedback_idx" ON "app"."review_findings" USING btree ("feedback","id" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "app"."models" DROP COLUMN "reviewer_experiment_weight";--> statement-breakpoint
ALTER TABLE "app"."models" DROP COLUMN "verifier_experiment_weight";--> statement-breakpoint
ALTER TABLE "app"."models" DROP COLUMN "review_diff_tokens";--> statement-breakpoint
ALTER TABLE "app"."review_file_evidence" DROP COLUMN "patch_delivered";--> statement-breakpoint
ALTER TABLE "app"."review_file_evidence" DROP COLUMN "delivered_at";--> statement-breakpoint
ALTER TABLE "app"."review_findings" DROP COLUMN "published";--> statement-breakpoint
ALTER TABLE "app"."review_findings" DROP COLUMN "verifier_confidence";--> statement-breakpoint
ALTER TABLE "app"."review_findings" DROP COLUMN "verifier_severity";--> statement-breakpoint
ALTER TABLE "app"."review_findings" DROP COLUMN "verification_reason";--> statement-breakpoint
ALTER TABLE "app"."reviews" DROP COLUMN "submission_id";--> statement-breakpoint
ALTER TABLE "app"."reviews" DROP COLUMN "candidate_count";--> statement-breakpoint
ALTER TABLE "app"."reviews" DROP COLUMN "verification_status";--> statement-breakpoint
ALTER TABLE "app"."reviews" DROP COLUMN "verification_model";--> statement-breakpoint
ALTER TABLE "app"."reviews" DROP COLUMN "verification_input_tokens";--> statement-breakpoint
ALTER TABLE "app"."reviews" DROP COLUMN "verification_output_tokens";--> statement-breakpoint
ALTER TABLE "app"."reviews" DROP COLUMN "verification_cost_usd";--> statement-breakpoint
ALTER TABLE "app"."reviews" DROP COLUMN "verification_latency_ms";--> statement-breakpoint
ALTER TABLE "app"."reviews" DROP COLUMN "experiment_key";