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