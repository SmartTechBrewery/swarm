-- Issue #1462: a completed Resolve problem run records which successful outcome its
-- report named — `resolved`, `already-resolved` or `handed-off` (diagnosed, and a
-- person must act). The run stays `completed`; this column tells a hand-off apart
-- from a resolution. Nullable with no backfill: NULL for every other phase, every
-- failed attempt and every pre-existing row.
ALTER TABLE "runs" ADD COLUMN "resolve_problem_outcome" text;
