ALTER TABLE "workers" ADD COLUMN "worktree_sweep_request_id" uuid;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "worktree_sweep_requested_at" timestamp;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "worktree_sweep_status" text;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "worktree_sweep_reported_at" timestamp;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "worktree_sweep_result" jsonb;