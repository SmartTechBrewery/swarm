-- Issue #1109: Review's check policy and check wait move off the project-wide
-- `pipeline.review.checks` / `pipeline.review.checksWaitMinutes` onto each
-- `repositories[]` entry (`ProjectRepositorySchema.reviewChecks` /
-- `reviewChecksWaitMinutes`, `src/config/schema.ts`), so a repository with CI on pull
-- requests and one without can differ.
--
-- Existing projects must keep their behaviour with no operator action, and the DB read
-- path cannot do it for them: `rowToProjectRecord`
-- (`src/db/repositories/projectsRepository.ts`) is a plain re-join with no parsing, so
-- unlike a `swarm.config.json` — which `adoptLegacyReviewChecks`
-- (`src/config/legacy-review-checks.ts`) adopts on parse — a persisted row needs this
-- one-time backfill. The rules are that function's, applied to each key independently:
-- every entry stating no value of its own takes the project's, an entry's own value
-- wins, and both keys are then removed from `pipeline.review` (its `enabled` stays).
--
-- Both `SET` expressions read the pre-update row, so the subquery sees the old
-- `pipeline`. `WITH ORDINALITY` keeps the list order, which is persisted and shown on
-- screen. A project that never set either key is untouched by the `WHERE` (unset still
-- reads as the defaults, `required` and 10 minutes), which also makes the statement
-- re-runnable. A legacy value of the wrong type is not copied; it is only dropped, since
-- it never parsed as a setting.
UPDATE "projects"
SET
	"repositories" = (
		SELECT jsonb_agg(
			"entry"
			|| CASE
				WHEN NOT ("entry" ? 'reviewChecks')
					AND "projects"."pipeline" #>> '{review,checks}' IN ('required', 'if-present')
				THEN jsonb_build_object('reviewChecks', "projects"."pipeline" #> '{review,checks}')
				ELSE '{}'::jsonb
			END
			|| CASE
				WHEN NOT ("entry" ? 'reviewChecksWaitMinutes')
					AND jsonb_typeof("projects"."pipeline" #> '{review,checksWaitMinutes}') = 'number'
				THEN jsonb_build_object(
					'reviewChecksWaitMinutes',
					"projects"."pipeline" #> '{review,checksWaitMinutes}'
				)
				ELSE '{}'::jsonb
			END
			ORDER BY "position"
		)
		FROM jsonb_array_elements("projects"."repositories") WITH ORDINALITY AS "items"("entry", "position")
	),
	"pipeline" = "pipeline" #- '{review,checks}' #- '{review,checksWaitMinutes}'
WHERE jsonb_typeof("pipeline" -> 'review') = 'object'
	AND ("pipeline" -> 'review' ? 'checks' OR "pipeline" -> 'review' ? 'checksWaitMinutes');
