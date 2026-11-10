-- Issue #1385: the scoped agent credential. `project_ids` limits an agent access token to
-- those projects (NULL is an ordinary, unscoped token); `credential_kind` and `agent_token_id`
-- tell an operator MCP write made with one apart from the account holder's own calls.
ALTER TABLE "operator_actions" ADD COLUMN "credential_kind" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "operator_actions" ADD COLUMN "agent_token_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_access_tokens" ADD COLUMN "project_ids" text[];
