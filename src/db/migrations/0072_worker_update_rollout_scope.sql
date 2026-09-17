-- Issue #1024: a staged fleet update can now be **installation-wide** — the same
-- rollout state machine issue #940 built, over every registered machine rather than
-- over one operator's own, started and read by an instance administrator.
--
-- `scope` is the set the rollout was asked of (`owner` | `installation`), which is a
-- different fact from `requested_by_user_id`, the person who asked. Existing rows
-- default to `'owner'`, which is verbatim what every one of them is, so nothing is
-- backfilled and an installation with rollout history reads exactly as it did.
--
-- The two partial unique indexes are the load-bearing half. The per-owner one is
-- **narrowed** to `scope = 'owner'`, so an administrator's installation-wide rollout
-- no longer consumes the slot their own fleet rollout needs; the new one keys on
-- `scope` alone under `scope = 'installation'`, a column that takes exactly one value
-- there, so it admits **at most one live installation-wide rollout** for the whole
-- installation. Both are decided by the index rather than by a read-then-insert, for
-- issue #940's own reason: two calls landing at the same instant would both find
-- nothing and both insert, and two overlapping rollouts would drain and undrain each
-- other's members. `halted`/`completed` rows stay exempt from both and accumulate as
-- history.
--
-- What no index expresses is that an installation-wide rollout overlaps *every*
-- owner-scoped one, so the two must not run at once either. No single key states
-- that, so it is a read in the policy (`src/api/worker-update-rollout.ts`) answered
-- with a `CONFLICT`, not a constraint here.
DROP INDEX "idx_worker_update_rollouts_owner_live";--> statement-breakpoint
ALTER TABLE "worker_update_rollouts" ADD COLUMN "scope" text DEFAULT 'owner' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_worker_update_rollouts_installation_live" ON "worker_update_rollouts" USING btree ("scope") WHERE "worker_update_rollouts"."status" = 'in_progress' AND "worker_update_rollouts"."scope" = 'installation';--> statement-breakpoint
CREATE UNIQUE INDEX "idx_worker_update_rollouts_owner_live" ON "worker_update_rollouts" USING btree ("requested_by_user_id") WHERE "worker_update_rollouts"."status" = 'in_progress' AND "worker_update_rollouts"."scope" = 'owner';