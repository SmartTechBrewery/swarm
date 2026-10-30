-- Issue #1210: when a Reset & restart of the run last began its destructive steps, so
-- the reconciler's periodic orphan backfill can stay out of a Reset of a run that has
-- no active dispatch (whose Reset otherwise writes nothing the settle grace reads).
ALTER TABLE "runs" ADD COLUMN "reset_started_at" timestamp;
