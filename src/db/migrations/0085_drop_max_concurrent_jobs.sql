-- Issue #1190: the project-wide job cap (`maxConcurrentJobs`) is retired. A repository is
-- now bounded by its WIP limit (`repositories[].wipLimit`, issue #1185) and a worker by
-- its enrollment's `concurrencyAllocation`, so nothing reads the column any more.
ALTER TABLE "projects" DROP COLUMN "max_concurrent_jobs";
--> statement-breakpoint
-- Dispatches still waiting on that cap at upgrade would otherwise wait forever: the
-- capacity promotion that woke them is gone, and the reconciler's timed republish
-- (`listWakeablePendingDispatches`) skipped them. Clearing the reason makes each one an
-- ordinary pending dispatch, which the startup reconciler republishes in its first pass;
-- `wake_seq` is bumped exactly as a deferral bumps it, so the republish gets a fresh
-- deterministic wake id rather than colliding with a stale one. Re-runnable: a second
-- pass matches nothing.
UPDATE "dispatches"
SET "wait_reason" = NULL, "wake_seq" = "wake_seq" + 1, "updated_at" = now()
WHERE "state" = 'pending' AND "wait_reason" = 'project-capacity';
--> statement-breakpoint
-- `pipeline.prioritizeContinuations` ordered those waiters and goes with them. A
-- `swarm.config.json` still stating it parses (the schema strips the unknown key), but
-- `rowToProjectRecord` re-joins the stored `pipeline` with no parsing, so a persisted
-- copy is removed here instead.
UPDATE "projects"
SET "pipeline" = "pipeline" - 'prioritizeContinuations'
WHERE jsonb_typeof("pipeline") = 'object' AND "pipeline" ? 'prioritizeContinuations';
