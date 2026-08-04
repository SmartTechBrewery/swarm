-- Issue #480: an enrollment always states this worker's share of the project.
-- Backfill before SET NOT NULL, which would otherwise reject the existing NULL
-- rows. `NULL` meant "bounded only by SWARM_WORKER_CONCURRENCY and
-- maxConcurrentJobs", and both default to 1, so on a default install these rows
-- already resolved to an effective 1. A worker launched with --concurrency > 1
-- serving a project whose maxConcurrentJobs > 1 is the one case where this
-- narrows behaviour: re-set those allocations deliberately (the value is visible
-- per enrollment in the worker detail view).
UPDATE "worker_project_enrollments" SET "concurrency_allocation" = 1 WHERE "concurrency_allocation" IS NULL;--> statement-breakpoint
ALTER TABLE "worker_project_enrollments" ALTER COLUMN "concurrency_allocation" SET DEFAULT 1;--> statement-breakpoint
ALTER TABLE "worker_project_enrollments" ALTER COLUMN "concurrency_allocation" SET NOT NULL;
