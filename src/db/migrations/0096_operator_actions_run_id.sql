-- Issue #1395: a run-bound scoped agent credential's guardrails (issue #1393) count per run, not per
-- token. A deferred Resolve problem run is retried under a freshly minted token while the earlier
-- one is deleted, so a count keyed on `agent_token_id` reset the write cap and the no-repeat ledger
-- on every retry. `run_id` carries no foreign key, like every column here: the audit row outlives
-- the run.
ALTER TABLE "operator_actions" ADD COLUMN "run_id" uuid;--> statement-breakpoint
CREATE INDEX "idx_operator_actions_run_tool" ON "operator_actions" USING btree ("run_id","tool","target");