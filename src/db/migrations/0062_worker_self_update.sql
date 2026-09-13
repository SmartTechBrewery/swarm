-- Issue #933: an operator can now ask a worker to move its SWARM install root to a
-- build and restart into it, so a fleet is updated from the control plane instead of
-- by hand on every machine.
--
-- Six columns that split cleanly in two. The **request** still outstanding:
-- `update_request_id` (the pending marker — the report route clears it only when the
-- reported id matches, so a report for a request an operator has since re-targeted is
-- recorded as history without un-pending the one now outstanding), `update_target`,
-- and `update_requested_at`. The **last outcome** the machine reported:
-- `update_status` (one of applied / already-current / refused / failed / declined),
-- `update_message`, and `update_reported_at`.
--
-- `update_target` is deliberately not cleared by a report: it is the target the
-- outcome beside it concerns, and an outcome naming no build answers nothing.
-- Requesting again overwrites all six, so a fresh pending request never shows a stale
-- verdict beside it.
--
-- All nullable with no default, on `draining_since`'s contract
-- (`0061_worker_draining.sql`): NULL is what every existing row says and is verbatim
-- the pre-existing behaviour, so there is nothing to backfill — a machine nobody has
-- asked to update has no request and no outcome. Deliberately untouched by the
-- handshake, for that column's reason too: these record the operator's request and the
-- machine's answer to it, not a fact the daemon re-declares on connect. What the
-- restarted machine comes back declaring is `build_commit` (issue #918), which the
-- handshake does rewrite, and that is the whole of the wiring the restart needs. No
-- index: nothing queries by any of them.
ALTER TABLE "workers" ADD COLUMN "update_request_id" uuid;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "update_target" text;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "update_requested_at" timestamp;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "update_status" text;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "update_message" text;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "update_reported_at" timestamp;