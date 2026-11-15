-- Issue #1464: the same check, adjudicated no-fix, failing on several approved pull-request
-- heads of one repository is recorded as one episode and reported once. Observations are
-- the per-head sightings detection reads; an episode stands while unresolved and young,
-- and the partial unique index keeps at most one standing per (project, repository, check).
CREATE TABLE "shared_check_failure_episodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" text NOT NULL,
	"repository" text NOT NULL,
	"check_name" text NOT NULL,
	"opened_at" timestamp DEFAULT now() NOT NULL,
	"reported_at" timestamp,
	"resolved_at" timestamp,
	"resolution" text
);
--> statement-breakpoint
CREATE TABLE "shared_check_failure_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" text NOT NULL,
	"repository" text NOT NULL,
	"check_name" text NOT NULL,
	"pr_number" text NOT NULL,
	"head_sha" text NOT NULL,
	"observed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shared_check_failure_episodes" ADD CONSTRAINT "shared_check_failure_episodes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_check_failure_observations" ADD CONSTRAINT "shared_check_failure_observations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_shared_check_failure_episodes_standing" ON "shared_check_failure_episodes" USING btree ("project_id","repository","check_name") WHERE "shared_check_failure_episodes"."resolved_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_shared_check_failure_observations_head" ON "shared_check_failure_observations" USING btree ("project_id","repository","check_name","pr_number","head_sha");--> statement-breakpoint
CREATE INDEX "idx_shared_check_failure_observations_check" ON "shared_check_failure_observations" USING btree ("project_id","repository","check_name","observed_at");