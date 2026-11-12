-- Issue #1433: an approving Review run records the head merge automation brought up
-- to date whose failed checks SWARM re-ran once before handing its red to
-- Respond-to-CI, and when. The head is the once-per-head bound (claimed while it
-- differs from `review_merge_approved_head_sha`); the instant is the re-run's settle
-- window. Nullable with no backfill: NULL means "never re-run".
ALTER TABLE "runs" ADD COLUMN "review_merge_checks_rerun_head_sha" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "review_merge_checks_rerun_at" timestamp;