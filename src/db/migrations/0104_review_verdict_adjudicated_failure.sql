-- Issue #1474: a Respond-to-CI `no-fix` verdict on an approved head covers only the
-- failure it was made on. `adjudicated_failure` records that failure (each failing
-- check, its attempt and first failed step) when the first automatic re-run is
-- requested; `failure_change_routed_at` is the once-per-head bound on sending a re-run
-- that failed differently back to Respond-to-CI. Nullable with no backfill: NULL means
-- "no signature" and "never re-routed", so existing heads keep the re-run policy.
ALTER TABLE "review_verdicts" ADD COLUMN "adjudicated_failure" jsonb;--> statement-breakpoint
ALTER TABLE "review_verdicts" ADD COLUMN "failure_change_routed_at" timestamp;