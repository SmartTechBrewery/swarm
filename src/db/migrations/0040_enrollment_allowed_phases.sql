-- Issue #509: an enrollment now also states which pipeline phases the project may
-- route to this worker — the owner's per-project choice, distinct from the
-- daemon-declared `workers.supported_phases`. Existing rows are backfilled by the
-- column default (every phase) rather than from that column: it states whichever
-- program last operated the worker row (a DB-free `connect` run declares a strict
-- subset of the host worker's repertoire), so seeding a durable owner choice from
-- it would permanently narrow enrollments nobody chose to narrow. Defaulting to
-- every phase keeps dispatch behaviour identical — eligibility still requires the
-- daemon to declare the phase — and leaves the choice to be made deliberately.
ALTER TABLE "worker_project_enrollments" ADD COLUMN "allowed_phases" jsonb DEFAULT '["planning","implementation","review","respond-to-review","respond-to-ci","resolve-conflicts"]'::jsonb NOT NULL;
