-- Issue #955: an operator can now ask one machine to sweep its own abandoned
-- `task-<id>` checkouts (`swarm workers sweep-worktrees <worker-id>`), and the
-- control plane records what that machine removed.
--
-- Five columns that split the same way `0062_worker_self_update.sql`'s do. The
-- **request** still outstanding: `worktree_sweep_request_id` (the pending marker —
-- the report route clears it only when the reported id matches, so a report for a
-- request an operator has since re-issued is recorded without un-pending the one
-- now outstanding) and `worktree_sweep_requested_at`. The **last outcome** the
-- machine reported: `worktree_sweep_status` (swept / failed),
-- `worktree_sweep_reported_at`, and `worktree_sweep_result`.
--
-- `worktree_sweep_result` is the machine's own record of the sweep: each removed
-- path with its qualifying age and the uncommitted/unpushed work the removal
-- destroyed, plus the totals (`WorktreeSweepResult`, `src/identity/worker.ts`).
-- That destroyed-work half is why the record is durable at all — an age-based
-- sweep removes a checkout holding real work by design, so it must not be readable
-- only in one machine's log.
--
-- **Only the most recent sweep per machine is retained**: asking again overwrites
-- all five. This is deliberately not a history table — with phase 3's weekly
-- cadence the one sweep kept is precisely "last week's", which is the question the
-- record exists to answer.
--
-- All nullable with no default, on `draining_since`'s contract
-- (`0061_worker_draining.sql`): NULL is what every existing row says and is
-- verbatim the pre-existing behaviour, so there is nothing to backfill — a machine
-- nobody has asked to sweep has no request and no outcome. Deliberately untouched
-- by the handshake, for that column's reason too. No index: nothing queries by any
-- of them, and the read is per machine.
ALTER TABLE "workers" ADD COLUMN "worktree_sweep_request_id" uuid;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "worktree_sweep_requested_at" timestamp;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "worktree_sweep_status" text;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "worktree_sweep_reported_at" timestamp;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "worktree_sweep_result" jsonb;