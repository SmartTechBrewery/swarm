-- Issue #1346: the audit trail of the operator MCP server's write tools — one row per
-- call (dry run or real, succeeded, refused or failed). No foreign keys on purpose: the
-- record must outlive the account and the project it names.
CREATE TABLE "operator_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"user_identifier" text NOT NULL,
	"tool" text NOT NULL,
	"project_id" text,
	"target" text NOT NULL,
	"reason" text NOT NULL,
	"dry_run" boolean NOT NULL,
	"input" jsonb NOT NULL,
	"outcome" text NOT NULL,
	"error" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE INDEX "idx_operator_actions_project_started" ON "operator_actions" USING btree ("project_id","started_at");--> statement-breakpoint
CREATE INDEX "idx_operator_actions_user_started" ON "operator_actions" USING btree ("user_id","started_at");