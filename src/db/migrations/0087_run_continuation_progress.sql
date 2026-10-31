-- Issue #1256: the Tier 2 continuation budget counts stalls, not stops. A run's
-- progress-bearing continuations and its consecutive no-progress streak, written by a
-- `checkpointed` settle and cleared, with `continuation_count`, by Reset & restart.
ALTER TABLE "runs" ADD COLUMN "continuation_progress_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "continuation_no_progress_streak" integer DEFAULT 0 NOT NULL;
