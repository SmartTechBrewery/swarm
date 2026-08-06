-- Issue: `planning` may only ever be allowed on an instance admin's own worker
-- (`PlanningRequiresInstanceAdminError`, `src/identity/worker-enrollment.ts`) —
-- independent of the daemon's self-declared `workers.supported_phases`, since in
-- production only the instance admin's machine ever holds the DATABASE_URL/REDIS_URL
-- `planning` needs. That check only guards the write path (`enrollWorker` /
-- `updateEnrollmentConstraints`) going forward; every enrollment written before it
-- existed still carries `planning` in `allowed_phases` from migration 0040's
-- full-repertoire backfill. Strip it now so a stale row can neither display as
-- allowed nor, if a worker's daemon ever mis-declares `supported_phases`, let
-- eligibility fall back to self-declaration alone for this one phase.
UPDATE "worker_project_enrollments"
SET "allowed_phases" = "allowed_phases" - 'planning'
WHERE "allowed_phases" @> '["planning"]'::jsonb
	AND "worker_id" IN (
		SELECT "w"."id"
		FROM "workers" "w"
		LEFT JOIN "users" "u" ON "u"."id" = "w"."owner_user_id"
		WHERE "u"."instance_admin" IS NOT TRUE
	);
