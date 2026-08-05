ALTER TABLE "runs" ADD COLUMN "checkpoint" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "continuation_count" integer DEFAULT 0 NOT NULL;