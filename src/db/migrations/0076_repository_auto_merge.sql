-- Issue #1066: merge automation moves off the project-wide
-- `pipeline.respondToReview.autoMerge` onto each `repositories[]` entry
-- (`ProjectRepositorySchema.autoMerge`, `src/config/schema.ts`), so two repositories of
-- one project can differ.
--
-- Existing projects must keep their behaviour with no operator action, and the DB read
-- path cannot do it for them: `rowToProjectRecord`
-- (`src/db/repositories/projectsRepository.ts`) is a plain re-join with no parsing, so
-- unlike a `swarm.config.json` — which `adoptLegacyAutoMerge`
-- (`src/config/legacy-auto-merge.ts`) adopts on parse — a persisted row needs this
-- one-time backfill. The rules are that function's: every entry stating no `autoMerge`
-- of its own takes the project's value, an entry's own value wins, and the key is then
-- removed from `pipeline.respondToReview`.
--
-- Both `SET` expressions read the pre-update row, so the subquery sees the old
-- `pipeline`. `WITH ORDINALITY` keeps the list order, which is persisted and shown on
-- screen. A project that never set the key is untouched by the `WHERE` (unset still
-- reads as off), which also makes the statement re-runnable. A non-boolean legacy value
-- is not copied; it is only dropped, since it never enabled merging.
UPDATE "projects"
SET
	"repositories" = (
		SELECT jsonb_agg(
			CASE
				WHEN "entry" ? 'autoMerge'
					OR jsonb_typeof("projects"."pipeline" #> '{respondToReview,autoMerge}') IS DISTINCT FROM 'boolean'
				THEN "entry"
				ELSE "entry" || jsonb_build_object('autoMerge', "projects"."pipeline" #> '{respondToReview,autoMerge}')
			END
			ORDER BY "position"
		)
		FROM jsonb_array_elements("projects"."repositories") WITH ORDINALITY AS "items"("entry", "position")
	),
	"pipeline" = "pipeline" #- '{respondToReview,autoMerge}'
WHERE jsonb_typeof("pipeline" -> 'respondToReview') = 'object'
	AND "pipeline" -> 'respondToReview' ? 'autoMerge';
