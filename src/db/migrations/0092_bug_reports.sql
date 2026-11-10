-- Issue #1383: SWARM's own bug reports. `bug_reports` is one report (status, project or
-- installation-wide, duplicate target, issue link, occurrence count and first/last seen);
-- `bug_report_occurrences` is each observation of it. No FK on `project_id` or the filer:
-- a report outlives its project and its author, as an `operator_actions` row does.
CREATE TABLE "bug_report_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"run_id" text,
	"dispatch_id" text,
	"task_id" text,
	"repository" text,
	"pr_number" integer,
	"note" text,
	"filed_by_user_id" uuid NOT NULL,
	"filed_by_user_identifier" text NOT NULL,
	"filed_by_run_id" text,
	"observed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bug_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"project_id" text,
	"duplicate_of_id" uuid,
	"github_issue_url" text,
	"filed_by_user_id" uuid NOT NULL,
	"filed_by_user_identifier" text NOT NULL,
	"filed_by_run_id" text,
	"occurrence_count" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp NOT NULL,
	"last_seen_at" timestamp NOT NULL,
	"status_changed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bug_report_occurrences" ADD CONSTRAINT "bug_report_occurrences_report_id_bug_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."bug_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bug_reports" ADD CONSTRAINT "bug_reports_duplicate_of_id_bug_reports_id_fk" FOREIGN KEY ("duplicate_of_id") REFERENCES "public"."bug_reports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_bug_report_occurrences_report_observed" ON "bug_report_occurrences" USING btree ("report_id","observed_at");--> statement-breakpoint
CREATE INDEX "idx_bug_reports_status_last_seen" ON "bug_reports" USING btree ("status","last_seen_at");--> statement-breakpoint
CREATE INDEX "idx_bug_reports_project_last_seen" ON "bug_reports" USING btree ("project_id","last_seen_at");