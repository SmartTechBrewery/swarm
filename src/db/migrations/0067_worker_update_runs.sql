ALTER TABLE "runs" ALTER COLUMN "repository" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "task_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "kind" text DEFAULT 'pipeline' NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "maintenance_request_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "maintenance_target" text;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_runs_maintenance_request" ON "runs" USING btree ("maintenance_request_id") WHERE "runs"."kind" <> 'pipeline';