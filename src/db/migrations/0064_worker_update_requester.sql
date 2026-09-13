-- Issue #922: an installation administrator can now ask machines they do not own to
-- move to a build (`swarm workers request-update <ref>`), so "who asked" stopped
-- being inferable from the row's owner.
--
-- `update_target` and `update_requested_at` (0062_worker_self_update.sql) already
-- record *which* build and *when*. This seventh column records *by whom*, which is
-- what makes a request auditable once the requester and the machine's owner can be
-- different people. It belongs to the **request** half of those columns: it is
-- written with them and reset by the next request, never by a report.
--
-- `ON DELETE SET NULL`, not the `ON DELETE CASCADE` on `owner_user_id`: a worker must
-- outlive whoever asked it to update, so deleting a requester leaves the machine
-- registered and the request merely unattributed.
--
-- Nullable with no default and nothing backfilled, on `draining_since`'s contract
-- (`0061_worker_draining.sql`): NULL is what every existing row says — including
-- every request made before this column existed — and is verbatim the pre-existing
-- behaviour. No index: nothing queries by it, and the audit read is per machine.
ALTER TABLE "workers" ADD COLUMN "update_requested_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "workers" ADD CONSTRAINT "workers_update_requested_by_user_id_users_id_fk" FOREIGN KEY ("update_requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
