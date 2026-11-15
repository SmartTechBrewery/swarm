-- Issue #1463: an adjudicated red approved head is re-run up to a bounded number of
-- times, spaced out, before SWARM hands it to the operator. The count is the bound,
-- spent by a compare-and-swap conditional update; `checks_rerun_at` becomes the
-- latest re-run's request instant. Backfill: a head already re-run under the
-- one-re-run policy has spent one attempt (a head already handed to the operator
-- keeps its `operator_notified_at`, so it stays handed off).
ALTER TABLE "review_verdicts" ADD COLUMN "checks_rerun_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "review_verdicts" SET "checks_rerun_attempts" = 1 WHERE "checks_rerun_at" IS NOT NULL;
