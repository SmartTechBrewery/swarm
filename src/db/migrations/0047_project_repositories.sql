-- Issue #684 phase 1: a project's per-repository settings become a list. The `repo`,
-- `base_branch` and `branch_prefix` columns leave the row and become the fields of an
-- entry in the new `repositories` jsonb column (`ProjectRepository`,
-- `src/config/schema.ts`), so a project can eventually own more than one repository
-- without a column per repository.
--
-- Existing projects must migrate with nothing re-entered by hand, and the DB read path
-- cannot do it for them: `rowToProjectRecord`
-- (`src/db/repositories/projectsRepository.ts`) is deliberately a dumb re-join with no
-- validation and no normalization. So the backfill runs here, between the ADD and the
-- SET NOT NULL, turning every existing project into the one-entry list it already was.
--
-- `scm_type` is deliberately *not* copied into the entry. It stays the project-level
-- default, which keeps an existing single-repository project's provider resolving
-- exactly as it does today; the entry-level override stays unset until an operator
-- states one for a repository that lives somewhere else.
--
-- Dropping `repo` takes its UNIQUE constraint with it — the one thing that kept
-- `findProjectByRepoFromDb` from resolving arbitrarily. Its replacement is a write-seam
-- guard, `assertRepositoriesUnclaimed` (`src/db/repositories/projectsRepository.ts`),
-- plus the deterministic `ORDER BY id` that lookup now applies.
ALTER TABLE "projects" ADD COLUMN "repositories" jsonb;--> statement-breakpoint
UPDATE "projects" SET "repositories" = jsonb_build_array(
	jsonb_build_object(
		'repo', "repo",
		'baseBranch', "base_branch",
		'branchPrefix', "branch_prefix"
	)
);--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "repositories" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT "projects_repo_unique";--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "repo";--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "base_branch";--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "branch_prefix";
