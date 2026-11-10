-- Issue #1393: the run-bound scoped agent credential. `run_id` binds an agent access token to one
-- run (dropped with it) and `max_write_actions` caps its real write-tool calls; the operator_actions
-- index serves the per-token guardrail reads the write-tool framework makes before each real call.
ALTER TABLE "agent_access_tokens" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_access_tokens" ADD COLUMN "max_write_actions" integer;--> statement-breakpoint
ALTER TABLE "agent_access_tokens" ADD CONSTRAINT "agent_access_tokens_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_operator_actions_agent_token_tool" ON "operator_actions" USING btree ("agent_token_id","tool","target");--> statement-breakpoint
CREATE INDEX "idx_agent_access_tokens_run_id" ON "agent_access_tokens" USING btree ("run_id");