-- Issue #683: a run now records the repository it acted on, in the same `owner/repo`
-- form `ProjectConfig.repo` uses, denormalized alongside `project_id` exactly as
-- `review_verdicts.repository` already is — a project id alone does not identify a
-- repository once a project spans several (backend / frontend / android / ios).
--
-- Added nullable, backfilled from the owning project, then made NOT NULL: `project_id`
-- is NOT NULL with an FK to `projects` and `projects.repo` is NOT NULL, so the backfill
-- reaches every existing row and the SET NOT NULL cannot fail. While a project holds one
-- repository the recorded value is exactly what `project.repo` would have supplied, so
-- nothing observable changes for existing installations.
ALTER TABLE "runs" ADD COLUMN "repository" text;--> statement-breakpoint
UPDATE "runs"
SET "repository" = "projects"."repo"
FROM "projects"
WHERE "projects"."id" = "runs"."project_id"
	AND "runs"."repository" IS NULL;--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "repository" SET NOT NULL;
