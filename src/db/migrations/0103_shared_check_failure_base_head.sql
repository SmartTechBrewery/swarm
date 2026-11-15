-- Issue #1471: an episode records the base branch's head it opened against, so the
-- base-branch-health sweep can tell when the base has advanced past it and resume
-- the affected approved pull requests once.
ALTER TABLE "shared_check_failure_episodes" ADD COLUMN "base_head_sha" text;
