-- Issue #1416: an enrollment now also records when its worker last claimed a phase
-- run for the project. It is read only by the opt-in "Shuffle workers" rotation
-- (`pipeline.shuffleWorkers`), which prefers the least recently dispatched eligible
-- worker. Nullable with no backfill: NULL means "never", which sorts first and falls
-- back to the configured worker order, so a project that turns shuffle on starts
-- rotating from the top of its list.
ALTER TABLE "worker_project_enrollments" ADD COLUMN "last_dispatched_at" timestamp;
